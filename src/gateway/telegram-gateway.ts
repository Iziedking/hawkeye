// Direct Telegram gateway via grammY. Full control over UX.

import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import { bus } from "../shared/event-bus";
import { OgComputeClient } from "../integrations/0g/compute";
import { OgStorageClient } from "../integrations/0g/storage";
import { ClaudeLlmClient, FallbackLlmClient } from "../integrations/claude/index";
import type { WalletManager } from "../integrations/privy/index";
import { routeMessage } from "./llm-router";
import type { RouterResult } from "./llm-router";
import type {
  MessageChannel,
  TradeIntent,
  TradeAmount,
  ChainClass,
  ChainId,
  TradingMode,
} from "../shared/types";
import { loadEnvLocal, envOr } from "../shared/env";
import { resolveToken, resolveChainAlias } from "../shared/tokens";
import { formatHealthForTelegram } from "../shared/health";

loadEnvLocal();

type ReplyCtx = { chatId: number };

type PendingReply = {
  ctx: ReplyCtx;
  rootHash: string | null;
  isTestnet?: boolean;
};

const CONVERSATIONAL_PROMPT = [
  "You are HAWKEYE, an autonomous on-chain crypto agent on Telegram.",
  "",
  "Your live capabilities:",
  "- Trade/snipe tokens (user pastes a contract address)",
  "- Research token safety, liquidity, price (DexScreener + GoPlus)",
  "- Find alpha: trending tokens, smart money, new listings",
  "- Manage wallets: create agent wallet, connect external wallet",
  "",
  "Coming soon: bridging, LP provision, portfolio tracking, copy trading, wallet analysis.",
  "",
  "Rules:",
  "- Be direct and natural. No fluff. 2-4 sentences max.",
  "- Never hallucinate prices, addresses, or data.",
  "- If the user wants to do something you can help with, tell them exactly how (e.g. paste a CA, say /wallet).",
  "- If something is coming soon, say so honestly but mention what you CAN do now.",
  "- You understand swaps, bridges, LP, DeFi, MEV, tokenomics, on-chain analysis.",
  "- Do not use markdown. Use plain text only. No asterisks, no headers.",
].join("\n");

export type TelegramGatewayDeps = {
  walletManager?: WalletManager | null;
  botToken?: string;
  llm?: FallbackLlmClient | null;
};

export type TelegramGatewayHandle = {
  bot: Bot;
  stop: () => void;
};

function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function codeAddr(addr: string): string {
  return `<code>${html(addr)}</code>`;
}

export async function startTelegramGateway(
  deps: TelegramGatewayDeps = {},
): Promise<TelegramGatewayHandle> {
  const token = deps.botToken ?? envOr("TELEGRAM_BOT_TOKEN", "");
  if (!token)
    throw new Error("TELEGRAM_BOT_TOKEN required. Set it in .env.local or pass via deps.");

  const bot = new Bot(token);
  const wm = deps.walletManager ?? null;
  const replyByRequestId = new Map<string, PendingReply>();

  const llm = deps.llm !== undefined ? deps.llm : await tryInitLlm();
  const storage = tryInitStorage();

  async function reply(
    ctx: ReplyCtx,
    text: string,
    parseMode: "HTML" | undefined = "HTML",
  ): Promise<void> {
    try {
      if (parseMode === "HTML") {
        await bot.api.sendMessage(ctx.chatId, text, { parse_mode: "HTML" });
      } else {
        await bot.api.sendMessage(ctx.chatId, text);
      }
    } catch (err) {
      console.error("[telegram] reply failed:", err);
    }
  }

  // Bus listeners for async agent responses
  const onExecuted = (pos: import("../shared/types").TradeExecutedPayload): void => {
    const pending = replyByRequestId.get(pos.intentId);
    if (!pending) return;
    replyByRequestId.delete(pos.intentId);
    void reply(
      pending.ctx,
      [
        "<b>Trade Executed</b>",
        `Filled: ${pos.filled.value} ${pos.filled.unit}`,
        `Entry: $${pos.entryPriceUsd.toFixed(6)}`,
        `TX: ${codeAddr(pos.txHash)}`,
      ].join("\n"),
    );
  };

  const onStrategy = (d: import("../shared/types").StrategyDecision): void => {
    if (d.decision === "REJECT") {
      const pending = replyByRequestId.get(d.intentId);
      if (!pending) return;
      replyByRequestId.delete(d.intentId);
      if (pending.isTestnet && d.reason.includes("No trading pair")) {
        void reply(
          pending.ctx,
          [
            `Testnet trading pairs aren't available through DEX aggregators.`,
            ``,
            `For live testing: try a mainnet trade with a small amount (e.g. $5 worth).`,
            `I can trade on Ethereum, Base, Arbitrum, Optimism, Polygon, and BSC.`,
          ].join("\n"),
        );
      } else {
        void reply(pending.ctx, `Trade rejected: ${html(d.reason)}`);
      }
      return;
    }
    if (d.decision !== "AWAIT_USER_CONFIRM") return;
    const pending = replyByRequestId.get(d.intentId);
    if (!pending) return;
    void reply(pending.ctx, `Confirm to proceed: ${html(d.reason)}`);
  };

  const onSafety = (r: import("../shared/types").SafetyReport): void => {
    const pending = replyByRequestId.get(r.intentId);
    if (!pending) return;
    if (r.score >= 70 && r.flags.length === 0) return;
    if (r.flags.length > 0) {
      const flagText = r.flags.join(", ");
      void reply(pending.ctx, `Safety warning: <b>${r.score}/100</b> — ${html(flagText)}`);
    }
  };

  const onResearchResult = (res: import("../shared/types").ResearchResult): void => {
    const pending = replyByRequestId.get(res.requestId);
    if (!pending) return;
    replyByRequestId.delete(res.requestId);
    void reply(pending.ctx, html(res.summary), undefined);
  };

  bus.on("TRADE_EXECUTED", onExecuted);
  bus.on("STRATEGY_DECISION", onStrategy);
  bus.on("SAFETY_RESULT", onSafety);
  bus.on("RESEARCH_RESULT", onResearchResult);

  // /start — welcome message
  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "<b>HAWKEYE</b> — Autonomous On-Chain Agent\n",
        "I can help you with:",
        "  Swap tokens across DEXes",
        "  Research token safety and data",
        "  Bridge assets between chains",
        "  Provide or manage liquidity",
        "  Track your portfolio and positions",
        "  Find alpha: trending tokens, smart money\n",
        "Get started:",
        "  /wallet — Create or view your agent wallet",
        "  Paste a contract address to trade",
        "  Ask me anything about crypto\n",
        "<i>Type /help for all commands</i>",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  // /status — health report
  bot.command("status", async (ctx) => {
    const report = formatHealthForTelegram();
    await ctx.reply(`<pre>${html(report)}</pre>`, { parse_mode: "HTML" });
  });

  // /help
  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Commands</b>\n",
        "/wallet — Create or view your wallet",
        "/status — System health and uptime",
        "/start — Welcome message\n",
        "<b>Wallet</b>",
        "<code>connect 0x...</code> — Link external wallet",
        "<code>use agent wallet</code> — Switch to HAWKEYE wallet",
        "<code>use external wallet</code> — Switch to your wallet\n",
        "<b>Trading</b>",
        "Paste a contract address to snipe",
        '"Swap 0.1 ETH to USDC on Base"',
        '"Bridge 0.5 ETH to Arbitrum"\n',
        "<b>Research</b>",
        '"Is 0x... safe?"',
        '"Check this token"',
        '"What\'s trending?"',
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  // /wallet — create on explicit request, show info
  bot.command("wallet", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    if (!wm) {
      await ctx.reply("Wallet system not available.");
      return;
    }

    const existing = wm.getWallet(userId);
    if (!existing) {
      try {
        const wallet = await wm.getOrCreateWallet(userId);
        await ctx.reply(
          [
            "<b>Wallet Created</b>\n",
            `Address: ${codeAddr(wallet.address)}`,
            "\nFund this address with ETH to start trading.",
            "Tap the address to copy it.",
          ].join("\n"),
          { parse_mode: "HTML" },
        );
      } catch (err) {
        await ctx.reply(`Failed to create wallet: ${(err as Error).message}`);
      }
      return;
    }

    const config = wm.getWalletConfig(userId);
    const lines: string[] = ["<b>Your Wallets</b>\n"];
    if (config.agentWallet) {
      lines.push(`Agent: ${codeAddr(config.agentWallet.address)}`);
    }
    if (config.externalAddress) {
      lines.push(`External: ${codeAddr(config.externalAddress)}`);
    }
    lines.push(`\nActive: <b>${config.mode}</b>`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // Message handler
  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const text = ctx.message.text;
    const rctx: ReplyCtx = { chatId: ctx.chat.id };
    const lower = text.trim().toLowerCase();

    // Wallet connect command
    const connectMatch = text.trim().match(/^(?:connect|link)\s+(0x[a-fA-F0-9]{40})$/i);
    if (wm && connectMatch) {
      wm.connectExternalWallet(userId, connectMatch[1]!);
      await ctx.reply(
        `External wallet connected: ${codeAddr(connectMatch[1]!)}\n\nYour trades will use this wallet. Say "use agent wallet" to switch back.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (wm && (lower === "use agent wallet" || lower === "use hawkeye wallet")) {
      wm.setWalletMode(userId, "agent");
      const w = wm.getWallet(userId);
      await ctx.reply(`Switched to agent wallet${w ? ": " + codeAddr(w.address) : ""}`, {
        parse_mode: "HTML",
      });
      return;
    }

    if (
      wm &&
      (lower === "use external wallet" ||
        lower === "use my wallet" ||
        lower === "use connected wallet")
    ) {
      const config = wm.getWalletConfig(userId);
      if (config.externalAddress) {
        wm.setWalletMode(userId, "external");
        await ctx.reply(`Switched to external wallet: ${codeAddr(config.externalAddress)}`, {
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply(
          `No external wallet connected. Say <code>connect 0x...</code> to link one.`,
          { parse_mode: "HTML" },
        );
      }
      return;
    }

    // Route through LLM router (0G primary, Claude fallback, regex last resort)
    const routerDeps = llm !== null ? { llm: llm as unknown as OgComputeClient } : {};
    const result = await routeMessage(
      { text, userId, channel: "telegram" as MessageChannel },
      routerDeps,
    );

    console.log(
      `[telegram] user=${userId} category=${result.category} confidence=${result.confidence.toFixed(2)} text="${text.slice(0, 50)}"`,
    );

    switch (result.category) {
      case "DEGEN_SNIPE":
      case "TRADE":
        return handleTrade(result, rctx, storage, replyByRequestId, wm, userId);
      case "RESEARCH_TOKEN":
        return handleResearch(result, rctx, replyByRequestId);
      case "RESEARCH_WALLET":
        return handleResearchWallet(result, rctx);
      case "COPY_TRADE":
        return handleComingSoon(rctx, "copy trading", result.rawText);
      case "BRIDGE":
        return handleBridge(result, rctx);
      case "PORTFOLIO":
        return handlePortfolio(result, rctx, wm, userId);
      case "SETTINGS":
        return handleSettings(result, rctx);
      case "GENERAL_QUERY":
      case "UNKNOWN":
      default:
        return handleConversational(result, rctx, llm);
    }
  });

  // --- Handlers ---

  async function llmReply(
    rctx: ReplyCtx,
    userMsg: string,
    context: string,
    fallbackText: string,
  ): Promise<void> {
    if (!llm) {
      void reply(rctx, fallbackText);
      return;
    }
    try {
      const resp = await llm.infer({
        system: CONVERSATIONAL_PROMPT + "\n\nContext for this reply: " + context,
        user: userMsg,
        temperature: 0.7,
        maxTokens: 300,
      });
      void reply(rctx, html(resp.text), "HTML");
    } catch {
      void reply(rctx, fallbackText);
    }
  }

  async function handleTrade(
    result: RouterResult,
    rctx: ReplyCtx,
    storage: OgStorageClient | null,
    pendingMap: Map<string, PendingReply>,
    walletMgr: WalletManager | null,
    userId: string,
  ): Promise<void> {
    const d = result.data;
    let address = typeof d["address"] === "string" ? d["address"] : null;
    let chain: ChainClass | null =
      d["chain"] === "evm" || d["chain"] === "solana" ? (d["chain"] as ChainClass) : null;
    const fromToken = typeof d["fromToken"] === "string" ? d["fromToken"] : null;
    const toToken = typeof d["toToken"] === "string" ? d["toToken"] : null;
    const chainHint = typeof d["chain"] === "string" ? d["chain"] : null;

    if (walletMgr && !walletMgr.getWallet(userId)) {
      void llmReply(
        rctx,
        result.rawText,
        "The user wants to trade but hasn't created a wallet yet. Tell them to use /wallet first. Keep it brief.",
        "You need a wallet first. Use /wallet to create one.",
      );
      return;
    }

    let resolvedChainName: string | null = null;

    if (!address && (fromToken || toToken)) {
      const targetSymbol = toToken ?? fromToken;
      if (targetSymbol) {
        const resolved = await resolveToken(targetSymbol, chainHint ?? undefined);
        if (resolved) {
          address = resolved.address;
          resolvedChainName = resolveChainAlias(resolved.chain) ?? resolved.chain;
          chain = resolvedChainName === "solana" ? "solana" : "evm";
          console.log(
            `[telegram] resolved "${targetSymbol}" → ${address} on ${resolved.chain} (${resolved.source}${resolved.liquidity ? ", liq=$" + resolved.liquidity.toFixed(0) : ""})`,
          );
        }
      }
    }

    if (!address) {
      const context =
        fromToken || toToken
          ? `The user wants to swap${fromToken ? " " + fromToken : ""}${toToken ? " to " + toToken : ""} but I couldn't find the token on any DEX. Ask if they can provide the contract address, or check the token name spelling.`
          : `The user wants to trade/swap but didn't specify which tokens. Ask what they want to swap and on which chain. Mention they can say things like "swap 0.1 ETH to USDC on Base" or paste a contract address.`;
      void llmReply(
        rctx,
        result.rawText,
        context,
        fromToken || toToken
          ? `Couldn't find ${toToken ?? fromToken} on any DEX. Check the name or paste the contract address.`
          : `What do you want to swap? Example: "swap 0.1 ETH to USDC on Base" or paste a contract address.`,
      );
      return;
    }

    if (!chain) chain = "evm";

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
      urgencyRaw === "INSTANT" || urgencyRaw === "CAREFUL" ? urgencyRaw : "NORMAL";

    const specificChain = resolvedChainName ?? chainHint ?? null;
    const intentBase = {
      intentId: result.id,
      userId: result.userId,
      channel: result.channel,
      address,
      chain,
      amount,
      exits: [] as TradeIntent["exits"],
      urgency,
      rawText: result.rawText,
      createdAt: result.routedAt,
    };
    const intent: TradeIntent = specificChain
      ? { ...intentBase, chainHint: specificChain as ChainId }
      : intentBase;

    const isTestnet = specificChain
      ? ["sepolia", "goerli", "mumbai", "fuji"].includes(specificChain)
      : false;
    const pending: PendingReply = { ctx: rctx, rootHash: null };
    if (isTestnet) pending.isTestnet = true;
    pendingMap.set(intent.intentId, pending);
    bus.emit("TRADE_REQUEST", intent);

    const tokenLabel = toToken
      ? `${html(toToken.toUpperCase())} (${codeAddr(address)})`
      : codeAddr(address);
    const chainLabel =
      specificChain && specificChain !== chain ? `${chain} (${html(specificChain)})` : chain;
    await reply(
      rctx,
      [
        `<b>Processing trade</b>`,
        `Token: ${tokenLabel}`,
        `Chain: ${chainLabel}`,
        fromToken && toToken
          ? `Swap: ${html(fromToken.toUpperCase())} → ${html(toToken.toUpperCase())}`
          : "",
        amount.value > 0 ? `Amount: ${amount.value} ${amount.unit}` : "",
        `\nSafety + Quote agents running in parallel...`,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    if (storage) {
      void storage
        .writeJson(intent.intentId, intent)
        .then((res) => {
          pending.rootHash = res.rootHash;
          console.log(`[telegram] 0G audit: intent=${intent.intentId} root=${res.rootHash}`);
        })
        .catch((err) => console.error("[telegram] 0G storage failed:", err));
    }
  }

  function handleResearch(
    result: RouterResult,
    rctx: ReplyCtx,
    pendingMap: Map<string, PendingReply>,
  ): void {
    const d = result.data;
    const address = typeof d["address"] === "string" ? d["address"] : null;
    const chain =
      d["chain"] === "evm" || d["chain"] === "solana" ? (d["chain"] as ChainClass) : null;

    const requestId = randomUUID();
    pendingMap.set(requestId, { ctx: rctx, rootHash: null });

    bus.emit("RESEARCH_REQUEST", {
      requestId,
      userId: result.userId,
      channel: result.channel,
      address,
      tokenName: typeof d["tokenName"] === "string" ? d["tokenName"] : null,
      chain,
      question: typeof d["question"] === "string" ? d["question"] : result.rawText,
      rawText: result.rawText,
      createdAt: Date.now(),
    });

    if (address) {
      void reply(
        rctx,
        `Researching ${codeAddr(address)}...\nAnalyzing safety, liquidity, and price data.`,
      );
    } else {
      void llmReply(
        rctx,
        result.rawText,
        "The user wants to research a token but didn't provide a contract address. Acknowledge their question and ask for the contract address for deeper analysis.",
        "Looking into that. For detailed analysis, paste the contract address.",
      );
    }
  }

  function handleResearchWallet(result: RouterResult, rctx: ReplyCtx): void {
    const d = result.data;
    const wallet = typeof d["walletAddress"] === "string" ? d["walletAddress"] : null;
    void llmReply(
      rctx,
      result.rawText,
      `The user wants wallet analysis${wallet ? " for " + wallet : ""}. This feature is coming soon. Mention what you CAN do now (trading, token research, alpha scanning).`,
      wallet
        ? `Wallet analysis is coming soon. For now I can research tokens and find alpha — paste a contract address or ask "what's trending?".`
        : `Paste a wallet address and I'll analyze it. Wallet tracking is coming soon.`,
    );
  }

  function handleBridge(result: RouterResult, rctx: ReplyCtx): void {
    void llmReply(
      rctx,
      result.rawText,
      "The user wants to bridge assets between chains. Bridge execution is coming soon. Tell them what you CAN do now (trade on specific chains, research tokens across chains).",
      "Bridge execution is coming soon. I can trade on specific chains right now — paste a contract address with the chain name.",
    );
  }

  function handlePortfolio(
    result: RouterResult,
    rctx: ReplyCtx,
    walletMgr: WalletManager | null,
    userId: string,
  ): void {
    if (!walletMgr || !walletMgr.getWallet(userId)) {
      void llmReply(
        rctx,
        result.rawText,
        "The user wants portfolio info but has no wallet. Tell them to use /wallet to create one.",
        "You need a wallet first. Use /wallet to create one, then I can track your positions.",
      );
      return;
    }
    const config = walletMgr.getWalletConfig(userId);
    void llmReply(
      rctx,
      result.rawText,
      `The user wants portfolio info. Their active wallet is ${config.activeAddress ?? "none"} (mode: ${config.mode}). Full portfolio tracking with live PnL is coming soon. Mention what you CAN do now.`,
      `Active wallet: ${config.activeAddress ?? "none"} (${config.mode}). Full portfolio tracking is coming soon.`,
    );
  }

  function handleSettings(result: RouterResult, rctx: ReplyCtx): void {
    void llmReply(
      rctx,
      result.rawText,
      "The user wants to change a setting. Acknowledge what they want to set. Persistent settings are coming soon — for now it applies to current session only.",
      "Settings update noted. Persistent settings are coming soon — applies to current session only.",
    );
  }

  function handleComingSoon(rctx: ReplyCtx, capability: string, rawText: string): void {
    void llmReply(
      rctx,
      rawText,
      `The user wants ${capability}. This feature is coming soon. Be honest about it, but mention what you CAN do right now (trading, token research, alpha scanning).`,
      `${capability} is coming soon. I can help with trading, token research, and market questions right now.`,
    );
  }

  async function handleConversational(
    result: RouterResult,
    rctx: ReplyCtx,
    llmClient: FallbackLlmClient | null,
  ): Promise<void> {
    if (!llmClient) {
      void reply(
        rctx,
        [
          `I'm running without my AI brain right now.`,
          ``,
          `I can still:`,
          `  Paste a contract address — I'll trade or research it`,
          `  Say "swap" — I'll guide you through a trade`,
          `  Say "/wallet" — manage your wallet`,
          `  Say "what's trending" — I'll scan for alpha`,
        ].join("\n"),
      );
      return;
    }

    try {
      const resp = await llmClient.infer({
        system: CONVERSATIONAL_PROMPT,
        user: result.rawText,
        temperature: 0.7,
        maxTokens: 300,
      });
      void reply(rctx, html(resp.text), "HTML");
    } catch {
      void reply(
        rctx,
        "Having trouble right now. Try pasting a contract address, or say /help to see what I can do.",
      );
    }
  }

  await bot.init();
  console.log(`[telegram] bot @${bot.botInfo.username} starting...`);
  bot.start({
    onStart: () => console.log(`[telegram] bot @${bot.botInfo.username} is live`),
  });

  return {
    bot,
    stop: () => {
      bus.off("TRADE_EXECUTED", onExecuted);
      bus.off("STRATEGY_DECISION", onStrategy);
      bus.off("SAFETY_RESULT", onSafety);
      bus.off("RESEARCH_RESULT", onResearchResult);
      bot.stop();
    },
  };
}

async function tryInitLlm(): Promise<FallbackLlmClient | null> {
  let ogClient: OgComputeClient | null = null;
  try {
    ogClient = new OgComputeClient();
  } catch (err) {
    console.warn("[telegram] 0G Compute client failed to construct:", (err as Error).message);
  }

  let claudeClient: ClaudeLlmClient | null = null;
  try {
    claudeClient = new ClaudeLlmClient();
  } catch (err) {
    console.warn("[telegram] Claude fallback unavailable:", (err as Error).message);
  }

  if (!claudeClient && !ogClient) {
    console.warn("[telegram] No LLM available — running regex-only mode");
    return null;
  }

  const client = new FallbackLlmClient(ogClient, claudeClient);
  await client.ready();
  return client;
}

function tryInitStorage(): OgStorageClient | null {
  try {
    const client = new OgStorageClient();
    console.log("[telegram] 0G Storage client initialized");
    return client;
  } catch (err) {
    console.warn("[telegram] 0G Storage unavailable:", (err as Error).message);
    return null;
  }
}
