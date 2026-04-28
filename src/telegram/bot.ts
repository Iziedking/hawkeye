/**
 * HAWKEYE Telegram Bot — Test Runner
 *
 * This is the entry point for testing. It connects Telegram to the full
 * agent swarm via the event bus.
 *
 * Architecture:
 *   Telegram message → OpenRouter LLM (intent classification) → Event Bus
 *   Event Bus results → Telegram reply
 *
 * Features:
 *   - Any plain text message is routed through the LLM router
 *   - /quote <address> — manual quote lookup
 *   - /status — swarm health check
 *   - /help — command reference
 *   - Multi-user support (userId = telegram user id)
 *   - Chain confirmation when auto-detected
 *
 * Run: npx tsx src/telegram/bot.ts
 */

import { Bot, Context } from "grammy";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { loadEnvLocal, requireEnv, envOr } from "../shared/env";
import { bus } from "../shared/event-bus";
import { routeMessage } from "../gateway/llm-router";
import type { RouterResult } from "../gateway/llm-router";
import { OpenRouterClient } from "../integrations/openrouter/client";
import { getChainName, getChainExplorer, getSupportedChains } from "../shared/evm-chains";
import { startQuoteAgent } from "../agents/quote";
import { startLightSafetyAgent } from "../agents/safety-light";
import {
  loadAllSkills,
  buildSkillPrompt,
  formatSkillList,
  toggleSkill,
  type LoadedSkill,
} from "../skills/loader";

import type {
  ChainClass,
  TradeIntent,
  TradeAmount,
  TradingMode,
  MessageChannel,
  Quote,
  SafetyReport,
  StrategyDecision,
  ResearchRequest,
} from "../shared/types";

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadEnvLocal();

const token = requireEnv("TELEGRAM_BOT_TOKEN");
const bot = new Bot(token);
const llm = new OpenRouterClient();

// Load skills
let skills: LoadedSkill[] = loadAllSkills();

// LLM response cache for speed (TTL 5 min)
const responseCache = new Map<string, { text: string; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Pending reply contexts: maps intentId/requestId → telegram chatId
const pendingReplies = new Map<string, number>();

// Chain confirmation flow: maps a key to the pending intent data
const pendingChainConfirm = new Map<
  string,
  { data: Record<string, unknown>; input: { text: string; userId: string; channel: MessageChannel } }
>();

// ---------------------------------------------------------------------------
// Start agents
// ---------------------------------------------------------------------------

startQuoteAgent();
startLightSafetyAgent();

// Lightweight Strategy Agent — auto-approves for testing
bus.on("QUOTE_RESULT", (quote: Quote) => {
  // Check if we also have a safety result
  const safetyKey = `safety-${quote.intentId}`;
  const safety = safetyCache.get(safetyKey);

  if (safety) {
    makeStrategyDecision(quote.intentId, quote, safety);
    safetyCache.delete(safetyKey);
  } else {
    quoteCache.set(`quote-${quote.intentId}`, quote);
  }
});

bus.on("SAFETY_RESULT", (safety: SafetyReport) => {
  const quoteKey = `quote-${safety.intentId}`;
  const quote = quoteCache.get(quoteKey);

  if (quote) {
    makeStrategyDecision(safety.intentId, quote, safety);
    quoteCache.delete(quoteKey);
  } else {
    safetyCache.set(`safety-${safety.intentId}`, safety);
  }
});

const quoteCache = new Map<string, Quote>();
const safetyCache = new Map<string, SafetyReport>();

function makeStrategyDecision(
  intentId: string,
  quote: Quote,
  safety: SafetyReport,
): void {
  const chatId = pendingReplies.get(intentId);

  if (safety.score < 40) {
    // Too risky
    bus.emit("STRATEGY_DECISION", {
      intentId,
      decision: "REJECT",
      reason: `Safety score ${safety.score}/100 — flags: ${safety.flags.join(", ") || "none"}`,
      rejectedAt: Date.now(),
    });

    if (chatId) {
      void bot.api.sendMessage(
        chatId,
        `🚫 *Trade Rejected*\n\n` +
          `Safety Score: ${safety.score}/100\n` +
          `Flags: ${safety.flags.join(", ") || "none"}\n` +
          `Reason: Too risky to proceed.`,
        { parse_mode: "Markdown" },
      ).catch(console.error);
    }
    return;
  }

  // Build the summary for user
  const summary =
    `📊 *Quote Ready*\n\n` +
    `💰 Price: $${quote.priceUsd.toFixed(8)}\n` +
    `💧 Liquidity: $${quote.liquidityUsd.toLocaleString()}\n` +
    `📉 Slippage: ~${quote.expectedSlippagePct.toFixed(2)}%\n` +
    `⛽ Fee: ~$${quote.feeEstimateUsd.toFixed(2)}\n` +
    `🔗 Chain: ${getChainName(quote.chainId)}\n` +
    `🛡️ Safety: ${safety.score}/100 ${safety.flags.length > 0 ? `⚠️ ${safety.flags.join(", ")}` : "✅"}\n` +
    `🛣️ Route: ${quote.route}\n\n` +
    `_Execution is in simulation mode for testing._`;

  if (chatId) {
    void bot.api.sendMessage(chatId, summary, { parse_mode: "Markdown" }).catch(console.error);
  }

  // For now, emit STRATEGY_DECISION but don't actually execute (dry run)
  bus.emit("STRATEGY_DECISION", {
    intentId,
    decision: "AWAIT_USER_CONFIRM",
    reason: `Quote: $${quote.priceUsd.toFixed(8)} | Safety: ${safety.score}/100 | Liquidity: $${quote.liquidityUsd.toLocaleString()}`,
    expiresAt: Date.now() + 60_000,
  });
}

// ---------------------------------------------------------------------------
// Bus event listeners → Telegram replies
// ---------------------------------------------------------------------------

bus.on("QUOTE_RESULT", (quote: Quote) => {
  const chatId = pendingReplies.get(quote.intentId);
  if (!chatId) return;

  console.log(
    `[TelegramBot] QUOTE_RESULT for ${quote.intentId} — $${quote.priceUsd}`,
  );
});

bus.on("SAFETY_RESULT", (report: SafetyReport) => {
  const chatId = pendingReplies.get(report.intentId);
  if (!chatId) return;

  console.log(
    `[TelegramBot] SAFETY_RESULT for ${report.intentId} — score=${report.score}`,
  );
});

// ---------------------------------------------------------------------------
// Conversational system prompt
// ---------------------------------------------------------------------------

const CONVERSATIONAL_PROMPT = `# HAWKEYE — Autonomous On-Chain Trading Agent

You are HAWKEYE, a veteran crypto-native AI agent deployed on Telegram.
You live and breathe DeFi. You speak the language of degens, traders, and builders.

## Your Identity
- You are an AI-powered on-chain execution agent built for speed and alpha.
- You operate across 15+ EVM chains: Ethereum, Base, Arbitrum, Polygon, BSC, Optimism, Avalanche, Fantom, zkSync, Linea, Blast, Scroll, Mantle, Celo, Cronos.
- You can look up token prices, check safety scores, and analyze liquidity when given a contract address.
- You understand MEV, slippage, liquidity pools, AMMs, bridges, yield farming, and tokenomics deeply.

## Your Knowledge
- DEXes: Uniswap v2/v3/v4, SushiSwap, PancakeSwap, Curve, Balancer, Aerodrome, Velodrome
- Chains: Gas costs, TPS, finality, bridge ecosystems, best chains for specific use cases
- Memecoins: Culture, launch patterns, rug indicators, community metrics, pump.fun
- DeFi: Lending (Aave, Compound), derivatives (GMX, dYdX), liquid staking (Lido), restaking (EigenLayer)
- Trading: Sniping, momentum, copy trading, whale watching, volume analysis
- Safety: Honeypot detection, tax analysis, contract verification, liquidity locks, ownership renouncement

## Rules
1. Be direct and opinionated. Share real views on tokens, chains, strategies.
2. Use crypto-native language naturally: ape in, diamond hands, rug pull, exit liquidity.
3. Give actionable advice. Tell users what to DO, not just definitions.
4. Be honest about risks. Always mention dangers.
5. NEVER fabricate on-chain data. If you need a contract address say "paste the CA and I'll check".
6. Keep it concise. Max 200 words. Telegram messages should be scannable.
7. Use emojis strategically: 🦅 brand, ⚠️ warnings, 🔥 alpha, 💎 conviction.
8. NEVER say "I can't help" or "I'm having trouble" — you ALWAYS have crypto opinions.

Supported Chains: ${getSupportedChains().map(c => getChainName(c)).join(", ")}`;

// Build the full prompt with skills injected
function getFullPrompt(): string {
  return CONVERSATIONAL_PROMPT + buildSkillPrompt(skills);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

bot.command("start", async (ctx: Context) => {
  await ctx.reply(
    `🦅 *Welcome to HAWKEYE*\n\n` +
      `I'm your autonomous on-chain trading agent.\n\n` +
      `*What I can do:*\n` +
      `• Paste a token address → instant price quote + safety check\n` +
      `• Ask me anything about crypto/DeFi\n` +
      `• /quote <address> — get a quick quote\n` +
      `• /status — check swarm status\n` +
      `• /chains — see supported networks\n\n` +
      `*Supported chains:* ${getSupportedChains().length} EVM networks\n\n` +
      `_Just send me a contract address or ask me anything!_`,
    { parse_mode: "Markdown" },
  );
});

bot.command("help", async (ctx: Context) => {
  await ctx.reply(
    `🦅 *HAWKEYE Commands*\n\n` +
      `/start — Welcome message\n` +
      `/quote <address> — Quick token quote\n` +
      `/chains — List supported networks\n` +
      `/skills — View/manage agent skills\n` +
      `/skill <name> on|off — Toggle a skill\n` +
      `/status — Swarm health check\n` +
      `/help — This message\n\n` +
      `Or just send me a token address or ask anything!`,
    { parse_mode: "Markdown" },
  );
});

bot.command("chains", async (ctx: Context) => {
  const chains = getSupportedChains()
    .map((c) => `• ${getChainName(c)}`)
    .join("\n");
  await ctx.reply(
    `🌐 *Supported EVM Chains*\n\n${chains}\n\n_All chains auto-detected from token address._`,
    { parse_mode: "Markdown" },
  );
});

bot.command("skills", async (ctx: Context) => {
  const list = formatSkillList(skills);
  await ctx.reply(
    `🧠 *Agent Skills*\n\n${list}\n\n_Toggle with_ /skill <filename> on|off`,
    { parse_mode: "Markdown" },
  );
});

bot.command("skill", async (ctx: Context) => {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  const name = parts[1];
  const action = parts[2]?.toLowerCase();

  if (!name || (action !== "on" && action !== "off")) {
    await ctx.reply(
      "Usage: `/skill <filename> on|off`\n\nExample: `/skill degen-trader on`",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const filename = name.endsWith(".md") ? name : `${name}.md`;
  const enabled = action === "on";
  const success = toggleSkill(filename, enabled);

  if (success) {
    // Reload skills
    skills = loadAllSkills();
    await ctx.reply(
      `${enabled ? "✅" : "⬜"} Skill *${name}* ${enabled ? "enabled" : "disabled"}`,
      { parse_mode: "Markdown" },
    );
  } else {
    await ctx.reply(`❌ Skill file \`${filename}\` not found.`, { parse_mode: "Markdown" });
  }
});

bot.command("status", async (ctx: Context) => {
  const quoteListeners = bus.listenerCount("TRADE_REQUEST");
  const safetyListeners = bus.listenerCount("TRADE_REQUEST");
  await ctx.reply(
    `🦅 *HAWKEYE Swarm Status*\n\n` +
      `🤖 LLM: OpenRouter (${llm.model})\n` +
      `📡 Quote Agent: ${quoteListeners > 0 ? "✅ Online" : "❌ Offline"}\n` +
      `🛡️ Safety Agent: ${safetyListeners > 0 ? "✅ Online" : "❌ Offline"}\n` +
      `🌐 Chains: ${getSupportedChains().length} EVM networks\n` +
      `⏱️ Uptime: ${formatUptime(process.uptime())}\n` +
      `📊 Pending: ${pendingReplies.size} intents`,
    { parse_mode: "Markdown" },
  );
});

bot.command("quote", async (ctx: Context) => {
  const text = ctx.message?.text ?? "";
  const parts = text.split(/\s+/);
  const address = parts[1];

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    await ctx.reply("Usage: `/quote 0x<token_address>`", {
      parse_mode: "Markdown",
    });
    return;
  }

  await ctx.reply(`🔍 Fetching quote for \`${address}\`...`, {
    parse_mode: "Markdown",
  });

  const intentId = randomUUID();
  const chatId = ctx.chat?.id;
  if (chatId) pendingReplies.set(intentId, chatId);

  const intent: TradeIntent = {
    intentId,
    userId: String(ctx.from?.id ?? "unknown"),
    channel: "telegram",
    address,
    chain: "evm",
    amount: { value: 0, unit: "NATIVE" },
    exits: [],
    urgency: "NORMAL",
    rawText: text,
    createdAt: Date.now(),
  };

  bus.emit("TRADE_REQUEST", intent);
});

// ---------------------------------------------------------------------------
// Main message handler — LLM-first routing
// ---------------------------------------------------------------------------

bot.on("message:text", async (ctx: Context) => {
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) return; // Already handled by command handlers

  const userId = String(ctx.from?.id ?? "unknown");
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  console.log(`[TelegramBot] Message from ${userId}: ${text.slice(0, 80)}`);

  // Show typing indicator immediately — feels fast
  await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

  try {
    // Route through the LLM
    const result = await routeMessage(
      { text, userId, channel: "telegram" },
      { llm: llm as any }, // OpenRouterClient is interface-compatible
    );

    console.log(
      `[TelegramBot] Routed: category=${result.category} confidence=${result.confidence.toFixed(2)}`,
    );

    switch (result.category) {
      case "DEGEN_SNIPE":
      case "TRADE":
        await handleTradeFromTelegram(ctx, result, chatId, userId);
        break;

      case "RESEARCH_TOKEN":
        await handleResearchFromTelegram(ctx, result, chatId, userId);
        break;

      case "GENERAL_QUERY":
      case "UNKNOWN":
      default:
        await handleConversational(ctx, text);
        break;

      case "BRIDGE":
      case "PORTFOLIO":
      case "COPY_TRADE":
      case "RESEARCH_WALLET":
      case "SETTINGS":
        await handleComingSoon(ctx, result.category);
        break;
    }
  } catch (err) {
    console.error("[TelegramBot] Error:", err);
    await ctx.reply(
      "⚠️ Something went wrong processing your message. Try again.",
    );
  }
});

// ---------------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------------

async function handleTradeFromTelegram(
  ctx: Context,
  result: RouterResult,
  chatId: number,
  userId: string,
): Promise<void> {
  const d = result.data;
  const address = typeof d["address"] === "string" ? d["address"] : null;
  const chain = d["chain"];

  if (!address) {
    await ctx.reply(
      "I detected a trade intent but couldn't find a valid token address. Paste the contract address directly.",
    );
    return;
  }

  // Only EVM for this phase
  if (chain === "solana") {
    await ctx.reply("🚧 Solana support coming soon. Currently EVM chains only.");
    return;
  }

  // Auto-detect chain from DexScreener — ask user to confirm
  await ctx.reply(
    `🔍 *Analyzing token...*\n\`${address}\`\n\n` +
      `_Checking price, safety, and liquidity across all EVM chains..._`,
    { parse_mode: "Markdown" },
  );

  const intentId = result.id;
  pendingReplies.set(intentId, chatId);

  const amountRaw = d["amount"] as Record<string, unknown> | null | undefined;
  let amount: TradeAmount = { value: 0, unit: "NATIVE" };
  if (amountRaw && typeof amountRaw === "object") {
    const v = typeof amountRaw["value"] === "number" ? amountRaw["value"] : 0;
    const u = amountRaw["unit"];
    const unit: TradeAmount["unit"] =
      u === "USD" || u === "TOKEN" || u === "NATIVE" ? u : "NATIVE";
    amount = { value: Number.isFinite(v) && v > 0 ? v : 0, unit };
  }

  const urgencyRaw = d["urgency"];
  const urgency: TradingMode =
    urgencyRaw === "INSTANT" || urgencyRaw === "CAREFUL"
      ? urgencyRaw
      : "NORMAL";

  const intent: TradeIntent = {
    intentId,
    userId,
    channel: "telegram",
    address,
    chain: "evm",
    amount,
    exits: [],
    urgency,
    rawText: result.rawText,
    createdAt: result.routedAt,
  };

  bus.emit("TRADE_REQUEST", intent);
}

async function handleResearchFromTelegram(
  ctx: Context,
  result: RouterResult,
  chatId: number,
  userId: string,
): Promise<void> {
  const d = result.data;
  const address = typeof d["address"] === "string" ? d["address"] : null;
  const question =
    typeof d["question"] === "string" ? d["question"] : result.rawText;

  if (address) {
    await ctx.reply(
      `🔬 *Researching token...*\n\`${address}\``,
      { parse_mode: "Markdown" },
    );

    // Treat research as a trade request to get quote + safety data
    const intentId = randomUUID();
    pendingReplies.set(intentId, chatId);

    bus.emit("TRADE_REQUEST", {
      intentId,
      userId,
      channel: "telegram" as MessageChannel,
      address,
      chain: "evm" as ChainClass,
      amount: { value: 0, unit: "NATIVE" as const },
      exits: [],
      urgency: "CAREFUL" as TradingMode,
      rawText: result.rawText,
      createdAt: Date.now(),
    });
  } else {
    // No address — use conversational LLM
    await handleConversational(ctx, result.rawText);
  }
}

async function handleConversational(
  ctx: Context,
  text: string,
): Promise<void> {
  const chatId = ctx.chat?.id;

  // Check cache first (same question within 5 min = instant reply)
  const cacheKey = text.toLowerCase().trim();
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log("[TelegramBot] Cache hit for:", cacheKey.slice(0, 40));
    await ctx.reply(cached.text);
    return;
  }

  // Send placeholder + keep typing indicator going
  const placeholder = await ctx.reply("🦅 _Thinking..._", { parse_mode: "Markdown" });

  // Keep typing indicator alive during LLM call
  const typingInterval = setInterval(() => {
    if (chatId) ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    const resp = await llm.infer({
      system: getFullPrompt(),
      user: text,
      temperature: 0.7,
      maxTokens: 800,
    });
    clearInterval(typingInterval);

    const reply = resp.text.trim();
    if (reply.length > 0) {
      // Edit the placeholder with the real response (feels instant)
      await ctx.api.editMessageText(
        placeholder.chat.id,
        placeholder.message_id,
        reply,
      ).catch(async () => {
        // Fallback: send new message if edit fails
        await ctx.reply(reply);
      });
      // Cache the response
      responseCache.set(cacheKey, { text: reply, ts: Date.now() });
    } else {
      await ctx.api.editMessageText(
        placeholder.chat.id,
        placeholder.message_id,
        "🦅 Didn't catch that. Try asking about tokens, chains, or trading strategies — or paste a contract address for a live scan.",
      ).catch(() => {});
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error("[TelegramBot] Conversational error:", err);
    await ctx.api.editMessageText(
      placeholder.chat.id,
      placeholder.message_id,
      "🦅 My LLM is warming up — give me a sec and try again.\n\n" +
        "Meanwhile, you can:\n" +
        "• Paste a token contract address for instant analysis\n" +
        "• Try /chains to see supported networks\n" +
        "• Try /status to check system health",
    ).catch(() => {});
  }
}

async function handleComingSoon(
  ctx: Context,
  category: string,
): Promise<void> {
  const names: Record<string, string> = {
    BRIDGE: "bridging assets across chains",
    PORTFOLIO: "portfolio tracking and PnL reports",
    COPY_TRADE: "copy trading",
    RESEARCH_WALLET: "wallet research and tracking",
    SETTINGS: "settings management",
  };
  await ctx.reply(
    `🚧 *Coming Soon*\n\n` +
      `${names[category] ?? category} is under development.\n\n` +
      `For now, I can help with:\n` +
      `• Token trading (paste a contract address)\n` +
      `• Token research\n` +
      `• Market questions`,
    { parse_mode: "Markdown" },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[TelegramBot] 🦅 HAWKEYE starting...");
  console.log(`[TelegramBot] LLM: OpenRouter (${llm.model})`);
  console.log(`[TelegramBot] Chains: ${getSupportedChains().length} EVM networks`);

  await llm.ready();

  bot.start({
    onStart: (botInfo) => {
      console.log(`[TelegramBot] ✅ Bot @${botInfo.username} is live`);
      console.log(`[TelegramBot] Send a message to https://t.me/${botInfo.username}`);
    },
  });
}

main().catch((err) => {
  console.error("[TelegramBot] Fatal:", err);
  process.exit(1);
});
