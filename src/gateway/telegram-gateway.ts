// Direct Telegram gateway via grammY. Full control over UX.

import { randomUUID } from "node:crypto";
import { Bot, InlineKeyboard } from "grammy";
import { bus } from "../shared/event-bus";
import { log as hlog } from "../shared/logger";
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
  PositionUpdate,
  QuoteFailedPayload,
  ResearchSubIntent,
} from "../shared/types";
import { loadEnvLocal, envOr } from "../shared/env";
import { resolveToken, resolveChainAlias, lookupKnownAddress } from "../shared/tokens";
import { formatHealthForTelegram, getHealth } from "../shared/health";
import {
  getChainRpc,
  getChainExplorer,
  getChainName,
  EVM_CHAIN_CONFIG,
  fetchNativeBalance,
  fetchTokenHoldings,
  fetchTokenBalance,
  fetchTokenDecimals,
  findWellKnownToken,
} from "../shared/evm-chains";
import { CONVERSATION_MAX_MESSAGES, CONVERSATION_TTL_MS } from "../shared/constants";
import { getPositionsByUser, getPosition } from "../agents/execution/index";
import { getTradeHistory } from "../shared/trade-history";
import { getWatchedWalletAddresses } from "../agents/copy-trade/index";
import { searchPairs } from "../tools/dexscreener-mcp/client";
import { loadSeenTokens, trackToken, getSeenTokens } from "../shared/seen-tokens";
import { composeSkillsPrompt, listSkills } from "../shared/skills";
import { getUserSkillOverrides, setUserSkillOverride } from "../shared/user-skills";
import { loadChats, getAllChats, rememberChatRoute } from "./chat-store";

loadEnvLocal();
loadSeenTokens();
loadChats();

type ReplyCtx = { chatId: number; userId: string };

type PendingReply = {
  ctx: ReplyCtx;
  rootHash: string | null;
  isTestnet?: boolean;
  walletAddress?: string;
  chainHint?: string;
  tradeAmount?: number;
  isSell?: boolean;
};

const CONVERSATIONAL_PROMPT = [
  "You are HAWKEYE, an autonomous on-chain crypto trading agent on Telegram.",
  "",
  "SUPPORTED CHAINS: EVM only (Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Sepolia testnet).",
  "SOLANA IS NOT SUPPORTED. You CANNOT create Solana wallets, swap on Solana, or do anything on Solana. If asked, say 'Solana support is coming soon. Right now I only work on EVM chains.'",
  "",
  "What you can actually do:",
  "- Create EVM wallets: /wallet",
  "- Buy and sell EVM tokens: paste a contract address or say 'buy PEPE on base'",
  "- Swap EVM tokens: 'swap 0.1 ETH to USDC on base'",
  "- Send ETH to wallets: 'send 0.01 ETH to 0xABC on sepolia'",
  "- Check wallet balances: 'what is my balance'",
  "- View open positions: 'show my positions'",
  "- Research tokens: paste a CA to check safety, liquidity, and price",
  "- Find trending tokens: 'what's trending on base?'",
  "- Trading modes: /mode degen, /mode normal, /mode safe",
  "",
  "Data sources: DexScreener, GoPlus, CoinGecko, Etherscan, Nansen, Arkham, Birdeye",
  "",
  "Rules:",
  "- Be direct and natural. No fluff. 2-4 sentences max.",
  "- NEVER invent prices, market caps, addresses, wallet addresses, or any data.",
  "- NEVER claim you created a wallet unless the /wallet command was used.",
  "- NEVER claim you can do something that is not in the list above.",
  "- If user asks about Solana, bridging, or features not listed: say it's coming soon.",
  "- If user asks about a specific token, tell them to paste the contract address.",
  "- Do not use markdown. Plain text only. No asterisks, no headers.",
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

const CHAIN_ALIASES: Record<string, { name: string; id: number }> = {
  ethereum: { name: "ethereum", id: 1 },
  eth: { name: "ethereum", id: 1 },
  base: { name: "base", id: 8453 },
  arbitrum: { name: "arbitrum", id: 42161 },
  arb: { name: "arbitrum", id: 42161 },
  optimism: { name: "optimism", id: 10 },
  op: { name: "optimism", id: 10 },
  polygon: { name: "polygon", id: 137 },
  matic: { name: "polygon", id: 137 },
  poly: { name: "polygon", id: 137 },
  bsc: { name: "bsc", id: 56 },
  bnb: { name: "bsc", id: 56 },
  avalanche: { name: "avalanche", id: 43114 },
  avax: { name: "avalanche", id: 43114 },
  sepolia: { name: "sepolia", id: 11155111 },
  "base-sepolia": { name: "base-sepolia", id: 84532 },
  basesepolia: { name: "base-sepolia", id: 84532 },
  fantom: { name: "fantom", id: 250 },
  ftm: { name: "fantom", id: 250 },
  cronos: { name: "cronos", id: 25 },
  cro: { name: "cronos", id: 25 },
  blast: { name: "blast", id: 81457 },
  scroll: { name: "scroll", id: 534352 },
  linea: { name: "linea", id: 59144 },
  mantle: { name: "mantle", id: 5000 },
  zksync: { name: "zksync", id: 324 },
  celo: { name: "celo", id: 42220 },
};

function resolveChainNumeric(input: string): { name: string; id: number } | null {
  return CHAIN_ALIASES[input.toLowerCase()] ?? null;
}

function nativeToWei(amount: number): string {
  const parts = amount.toFixed(18).split(".");
  const whole = parts[0] ?? "0";
  const frac = (parts[1] ?? "").padEnd(18, "0").slice(0, 18);
  return (BigInt(whole) * BigInt("1000000000000000000") + BigInt(frac)).toString();
}

// Convert a human amount (e.g. 3.997) into the token's raw integer units
// using its decimals. Mirrors nativeToWei but parameterised on `decimals`.
function tokenAmountToRaw(amount: number, decimals: number): bigint {
  const parts = amount.toFixed(decimals).split(".");
  const whole = parts[0] ?? "0";
  const frac = (parts[1] ?? "").padEnd(decimals, "0").slice(0, decimals);
  const scale = BigInt(10) ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(frac || "0");
}

// Per-chain gas reserve for native sends (wei). The cushion is the *upper
// bound* a 21k transfer should ever cost; any wallet that can't cover its
// `amount + reserve` won't be able to mine the tx. Mainnet uses 0.0015 ETH
// (~50 gwei * 21k * 1.5 safety). L2 transfers cost ~0.0000001 ETH so we use
// 0.00005 — large enough for gas spikes, small enough that a $9.30 wallet
// can still send $9 (which the old uniform 0.0015 reserve refused).
function nativeGasReserveWei(chainName: string): bigint {
  switch (chainName) {
    case "ethereum":
      return 1_500_000_000_000_000n; // 0.0015 ETH
    case "base":
    case "arbitrum":
    case "optimism":
      return 50_000_000_000_000n; // 0.00005 ETH
    case "bsc":
      return 300_000_000_000_000n; // 0.0003 BNB
    case "polygon":
      return 10_000_000_000_000_000n; // 0.01 MATIC
    case "avalanche":
      return 500_000_000_000_000n; // 0.0005 AVAX
    case "sepolia":
      return 100_000_000_000_000n; // 0.0001 ETH (testnet)
    default:
      return 1_500_000_000_000_000n;
  }
}

// ERC-20 transfer(address,uint256) calldata. Selector 0xa9059cbb followed by
// two 32-byte params: address (left-padded) and amount.
function encodeErc20Transfer(to: string, amount: bigint): string {
  const addr = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = amount.toString(16).padStart(64, "0");
  return "0xa9059cbb" + addr + amt;
}

const nativePriceCache: Record<string, { usd: number; at: number }> = {
  ethereum: { usd: 2500, at: 0 },
  matic_network: { usd: 0.5, at: 0 },
  binancecoin: { usd: 600, at: 0 },
};
const NATIVE_PRICE_TTL = 60_000;

const CURRENCY_TO_COINGECKO: Record<string, string> = {
  ETH: "ethereum",
  MATIC: "matic_network",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
  FTM: "fantom",
  CRO: "crypto-com-chain",
  MNT: "mantle",
  CELO: "celo",
};

async function fetchNativePrice(currency: string): Promise<number> {
  const coinId = CURRENCY_TO_COINGECKO[currency] ?? "ethereum";
  const cached = nativePriceCache[coinId];
  if (cached && Date.now() - cached.at < NATIVE_PRICE_TTL) return cached.usd;
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, { usd?: number }>;
      const price = data[coinId]?.usd;
      if (price && price > 0) {
        nativePriceCache[coinId] = { usd: price, at: Date.now() };
        return price;
      }
    }
  } catch {
    /* use cached */
  }
  return cached?.usd ?? 0;
}

async function fetchEthPrice(): Promise<number> {
  return fetchNativePrice("ETH");
}

export async function startTelegramGateway(
  deps: TelegramGatewayDeps = {},
): Promise<TelegramGatewayHandle> {
  const token = deps.botToken ?? envOr("TELEGRAM_BOT_TOKEN", "");
  if (!token)
    throw new Error("TELEGRAM_BOT_TOKEN required. Set it in .env.local or pass via deps.");

  const bot = new Bot(token);
  bot.catch((err) => {
    console.error("[telegram] bot error:", err.message ?? err);
  });
  const wm = deps.walletManager ?? null;
  const replyByRequestId = new Map<string, PendingReply>();

  // userId email → chat info, populated on every interaction. Lets the
  // wallet-watcher (and any future async notification source) reach the user
  // without having to thread chat context through the bus. Hydrated on boot
  // from data/chats.json so async alerts work even before a user re-pings
  // after a restart.
  const chatByEmail = new Map<string, { chatId: number; telegramId: string }>();
  for (const [email, route] of getAllChats()) {
    chatByEmail.set(email, { chatId: route.chatId, telegramId: route.telegramId });
  }

  function rememberChat(telegramId: string, chatId: number): void {
    if (!wm) return;
    const cfg = wm.getFullWalletConfig(telegramId);
    if (!cfg?.email) return;
    chatByEmail.set(cfg.email, { chatId, telegramId });
    // Persist only when the route is new or changed — rememberChatRoute
    // returns false when the same triple is already on disk. Skip the
    // synthetic @hawkeye.local emails; once the user runs /wallet with a
    // real email, linkEmail re-keys the profile and the next middleware
    // tick will record the real route. Persisting synthetics just leaves
    // dead entries on disk.
    if (cfg.email.endsWith("@hawkeye.local")) return;
    rememberChatRoute(cfg.email, chatId, telegramId);
  }

  // Middleware: record the chat for every incoming update so notifications
  // can find their user later. Always run, never short-circuit.
  bot.use(async (ctx, next) => {
    const tid = ctx.from?.id;
    const cid = ctx.chat?.id;
    if (typeof tid === "number" && typeof cid === "number") {
      rememberChat(String(tid), cid);
    }
    await next();
  });

  const llm = deps.llm !== undefined ? deps.llm : await tryInitLlm();
  const storage = tryInitStorage();

  type ConversationEntry = { role: "user" | "assistant"; content: string; at: number };
  const conversations = new Map<string, ConversationEntry[]>();

  function addMessage(uid: string, role: "user" | "assistant", content: string): void {
    let history = conversations.get(uid);
    if (!history) {
      history = [];
      conversations.set(uid, history);
    }
    history.push({ role, content: content.slice(0, 500), at: Date.now() });
    const cutoff = Date.now() - CONVERSATION_TTL_MS;
    while (history.length > 0 && history[0]!.at < cutoff) history.shift();
    if (history.length > CONVERSATION_MAX_MESSAGES) {
      history.splice(0, history.length - CONVERSATION_MAX_MESSAGES);
    }
  }

  function recentHistory(uid: string): string {
    const history = conversations.get(uid);
    if (!history || history.length === 0) return "";
    const cutoff = Date.now() - CONVERSATION_TTL_MS;
    const valid = history.filter((e) => e.at > cutoff);
    if (valid.length === 0) return "";
    return (
      "\n\nRecent conversation:\n" +
      valid.map((e) => `${e.role === "user" ? "User" : "HAWKEYE"}: ${e.content}`).join("\n")
    );
  }

  async function reply(
    ctx: ReplyCtx,
    text: string,
    parseMode: "HTML" | undefined = "HTML",
  ): Promise<void> {
    addMessage(ctx.userId, "assistant", text.replace(/<[^>]+>/g, ""));
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

  async function replyWithKeyboard(
    ctx: ReplyCtx,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    addMessage(ctx.userId, "assistant", text.replace(/<[^>]+>/g, ""));
    try {
      await bot.api.sendMessage(ctx.chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (err) {
      console.error("[telegram] reply failed:", err);
    }
  }

  function formatUsd(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
    if (n >= 1) return n.toFixed(2);
    return n.toPrecision(4);
  }

  type TrendingEntry = { address: string; symbol: string; chain: string };

  function parseTrendingEntries(summary: string): TrendingEntry[] {
    const entries: TrendingEntry[] = [];
    const lines = summary.split("\n");
    for (let i = 0; i < lines.length && entries.length < 3; i++) {
      const symMatch = lines[i]!.match(/^\d+\.\s+(\S+)/);
      if (!symMatch) continue;
      const symbol = symMatch[1]!;
      const chainLine = lines[i + 1] ?? "";
      const chainMatch = chainLine.match(/^\s+([\w-]+)\s*\|/);
      const chain = chainMatch ? chainMatch[1]!.trim() : "ethereum";
      const addrLine = lines[i + 2] ?? "";
      const addrMatch = addrLine.match(/^\s+(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\s*$/);
      if (addrMatch) {
        entries.push({ address: addrMatch[1]!, symbol, chain });
      }
    }
    return entries;
  }

  function buildTrendingKeyboard(summary: string): InlineKeyboard | null {
    const entries = parseTrendingEntries(summary);
    if (entries.length === 0) return null;
    const kb = new InlineKeyboard();
    for (const entry of entries) {
      kb.text(`Research ${entry.symbol}`, `research:${entry.address}`);
    }
    return kb;
  }

  // Bus listeners for async agent responses
  const onExecuted = (pos: import("../shared/types").TradeExecutedPayload): void => {
    const pending = replyByRequestId.get(pos.intentId);
    if (!pending) return;
    replyByRequestId.delete(pos.intentId);
    const explorer = getChainExplorer(pos.chainId);
    const chainName = getChainName(pos.chainId);
    const tokenLabel = pos.symbol ?? pos.address.slice(0, 10) + "...";
    const verb = pending.isSell ? "Sold" : "Bought";

    // Format the filled amount with the actual token symbol when the unit is
    // TOKEN/PERCENT (otherwise the literal string "TOKEN" leaks into the UI).
    const amtStr = (() => {
      switch (pos.filled.unit) {
        case "USD":
          return `$${pos.filled.value}`;
        case "TOKEN":
          return `${pos.filled.value} ${pos.symbol ?? "tokens"}`;
        case "PERCENT":
          return `${pos.filled.value}% of position`;
        case "NATIVE":
          return `${pos.filled.value} ${pos.chainId === "ethereum" || pos.chainId === "sepolia" || pos.chainId === "base" || pos.chainId === "arbitrum" || pos.chainId === "optimism" ? "ETH" : "native"}`;
        default:
          return `${pos.filled.value}`;
      }
    })();

    // Suppress the price suffix when there's no real price (testnet tokens
    // come back as 0 since DexScreener doesn't index them).
    const priceStr =
      pos.entryPriceUsd > 0
        ? pos.entryPriceUsd >= 1
          ? `$${pos.entryPriceUsd.toFixed(2)}`
          : `$${pos.entryPriceUsd.toFixed(6)}`
        : null;
    const fillLine = priceStr ? `${verb} ${amtStr} at ${priceStr}` : `${verb} ${amtStr}`;

    const tags: string[] = [];
    if (pos.mevProtected) tags.push("MEV Protected");
    if (pending.rootHash) tags.push("0G Verified");
    const msgLines = [
      `<b>${html(tokenLabel)}</b> on ${html(chainName)}`,
      ``,
      fillLine,
      ``,
      `<a href="${explorer}/tx/${pos.txHash}">${pos.txHash.slice(0, 16)}...</a>`,
      ...(tags.length > 0 ? [`${tags.join(" | ")}`] : []),
    ];
    void reply(pending.ctx, msgLines.join("\n"));
  };

  type PendingConfirmation = {
    ctx: ReplyCtx;
    intentId: string;
    messageId?: number;
    timer: ReturnType<typeof setTimeout>;
  };
  const pendingConfirmations = new Map<string, PendingConfirmation>();

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
        void reply(pending.ctx, `Rejected: ${html(d.reason)}`);
      }
      return;
    }
    if (d.decision !== "AWAIT_USER_CONFIRM") return;
    const pending = replyByRequestId.get(d.intentId);
    if (!pending) return;

    const keyboard = new InlineKeyboard()
      .text("Confirm", `confirm:${d.intentId}`)
      .text("Reject", `reject:${d.intentId}`);

    const timer = setTimeout(() => {
      const pc = pendingConfirmations.get(d.intentId);
      if (!pc) return;
      pendingConfirmations.delete(d.intentId);
      if (pc.messageId) {
        void bot.api
          .editMessageText(pc.ctx.chatId, pc.messageId, `Confirmation expired for this trade.`)
          .catch(() => {});
      }
    }, 60_000);

    const pc: PendingConfirmation = { ctx: pending.ctx, intentId: d.intentId, timer };
    pendingConfirmations.set(d.intentId, pc);

    void bot.api
      .sendMessage(pending.ctx.chatId, `${html(d.reason)}`, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      })
      .then((msg) => {
        pc.messageId = msg.message_id;
      })
      .catch((err) => console.error("[telegram] confirm keyboard failed:", err));
  };

  const onSafety = (r: import("../shared/types").SafetyReport): void => {
    const pending = replyByRequestId.get(r.intentId);
    if (!pending) return;
    if (pending.isSell) return;
    if (r.score >= 70 && r.flags.length === 0) return;
    if (r.flags.length > 0) {
      const flagText = r.flags.join(", ");
      void reply(pending.ctx, `Safety ${r.score}/100 — ${html(flagText)}`);
    }
  };

  // Cache address→chain from trending results so research callbacks know which chain to query
  const trendingChainCache = new Map<string, string>();

  // Per-user last researched token — so "buy $2" uses the token from conversation context
  type LastResearch = {
    address: string;
    chain: ChainClass;
    specificChain?: string;
    symbol: string;
    at: number;
  };
  const lastResearchByUser = new Map<string, LastResearch>();

  // Per-user pending buy from inline keyboard — holds full context until user provides amount
  type PendingBuy = {
    address: string;
    chain: ChainClass;
    specificChain: string;
    symbol: string;
    at: number;
  };
  const pendingBuyByUser = new Map<string, PendingBuy>();

  const onResearchResult = (res: import("../shared/types").ResearchResult): void => {
    const pending = replyByRequestId.get(res.requestId);
    if (!pending) return;
    replyByRequestId.delete(res.requestId);

    if (res.isTrending || res.address === "trending") {
      const entries = parseTrendingEntries(res.summary);
      for (const e of entries) {
        trendingChainCache.set(e.address.toLowerCase(), e.chain);
      }
      const kb = buildTrendingKeyboard(res.summary);
      if (kb) {
        void replyWithKeyboard(pending.ctx, html(res.summary), kb);
      } else {
        void reply(pending.ctx, html(res.summary), undefined);
      }
      return;
    }

    const lines: string[] = [];
    const subIntentHeaders: Partial<Record<ResearchSubIntent, string>> = {
      WHALE_ANALYSIS: "<b>Whale Intelligence</b>",
      SAFETY_CHECK: "<b>Safety Analysis</b>",
      PRICE_ACTION: "<b>Price Action</b>",
      MARKET_OVERVIEW: "<b>Market Overview</b>",
      CATEGORY: "<b>Category Tokens</b>",
      RESEARCH_WALLET: "<b>Wallet Intelligence</b>",
    };
    if (res.subIntent && subIntentHeaders[res.subIntent]) {
      lines.push(subIntentHeaders[res.subIntent]!);
      lines.push("");
    }
    const hasName =
      (res.symbol && !res.symbol.startsWith("0x")) ||
      (res.tokenName && !res.tokenName.startsWith("0x"));
    const label = hasName
      ? (res.symbol ?? res.tokenName ?? res.address.slice(0, 10))
      : res.address.slice(0, 10);

    // Header
    if (hasName) {
      const nameTag =
        res.tokenName && !res.tokenName.startsWith("0x") ? ` (${html(res.tokenName)})` : "";
      lines.push(`<b>${html(res.symbol ?? "")}${nameTag}</b>`);
    } else {
      lines.push(`<b>${codeAddr(res.address)}</b>`);
    }

    // Price row
    const priceRow: string[] = [];
    if (res.priceUsd != null) priceRow.push(`$${formatUsd(res.priceUsd)}`);
    if (res.priceChange24h != null) {
      const sign = res.priceChange24h >= 0 ? "+" : "";
      priceRow.push(`${sign}${res.priceChange24h.toFixed(1)}%`);
    }
    if (priceRow.length) lines.push(priceRow.join("  "));

    // Stats
    const stats: string[] = [];
    if (res.liquidityUsd != null) stats.push(`Liq $${formatUsd(res.liquidityUsd)}`);
    if (res.volume24h != null) stats.push(`Vol $${formatUsd(res.volume24h)}`);
    if (res.fdv != null && res.fdv > 0) stats.push(`FDV $${formatUsd(res.fdv)}`);
    if (stats.length) lines.push(stats.join("  "));

    // Safety
    if (res.safetyScore !== null) {
      const bar = res.safetyScore >= 70 ? "OK" : res.safetyScore >= 40 ? "CAUTION" : "DANGER";
      const flagStr = res.flags.length > 0 ? ` (${res.flags.join(", ")})` : "";
      lines.push(`Safety ${res.safetyScore}/100 ${bar}${flagStr}`);
    } else if (res.flags.length > 0) {
      lines.push(`Flags: ${res.flags.join(", ")}`);
    }

    if (res.opportunityScore != null) {
      lines.push(`Opportunity ${res.opportunityScore}/100`);
    }

    lines.push("");
    lines.push(html(res.summary));

    // Save last researched token for this user so "buy $2" uses it
    if (res.address !== "trending" && pending.ctx.userId) {
      lastResearchByUser.set(pending.ctx.userId, {
        address: res.address,
        chain: (res.chain === "solana" ? "solana" : "evm") as ChainClass,
        ...(res.chain ? { specificChain: res.chain } : {}),
        symbol: label,
        at: Date.now(),
      });
    }

    const kb = new InlineKeyboard()
      .text(`Buy ${label}`, `buy:${res.address}:${res.chain}`)
      .text("Refresh", `research:${res.address}`);
    void replyWithKeyboard(pending.ctx, lines.join("\n"), kb);
  };

  const onQuoteFailed = (qf: QuoteFailedPayload): void => {
    const pending = replyByRequestId.get(qf.intentId);
    if (!pending) return;
    replyByRequestId.delete(qf.intentId);
    hlog.bus("QUOTE_FAILED", `intent=${qf.intentId.slice(0, 8)} reason=${qf.reason.slice(0, 80)}`);

    if (
      /insufficient funds|exceeds the balance/i.test(qf.reason) &&
      pending.walletAddress &&
      pending.chainHint
    ) {
      void (async () => {
        try {
          const { balance } = await fetchNativeBalance(pending.chainHint!, pending.walletAddress!);
          const ethBal = Number(balance) / 1e18;
          const ethPrice = await fetchEthPrice().catch(() => 2500);
          const usdBal = ethBal * ethPrice;
          const chainName = getChainName(pending.chainHint!);
          const needed = pending.tradeAmount
            ? `  Need ~${pending.tradeAmount.toFixed(6)} ETH.`
            : "";
          void reply(
            pending.ctx,
            `Not enough funds on ${html(chainName)}.\n` +
              `Balance: ${ethBal.toFixed(6)} ETH (~$${usdBal.toFixed(2)})${needed}`,
          );
        } catch {
          void reply(pending.ctx, "Insufficient funds. Check your wallet balance with /wallet.");
        }
      })();
      return;
    }

    let userMsg = qf.reason;
    if (/insufficient funds|exceeds the balance/i.test(qf.reason)) {
      userMsg = "Insufficient funds. Check your wallet balance with /wallet.";
    } else if (/No trade amount/i.test(qf.reason)) {
      userMsg = "No trade amount specified. Say 'buy $5 worth' or 'buy 0.01 ETH'.";
    } else if (/No trading pairs/i.test(qf.reason)) {
      userMsg =
        "No trading pairs found on any DEX. The token may be too new, unlisted, or on an unsupported chain.";
    } else if (/execution reverted|transaction_broadcast_failure/i.test(qf.reason)) {
      userMsg =
        "Transaction reverted. Your wallet may not hold this token or may not have enough ETH for gas. Use /wallet to check.";
    } else if (/fetch failed/i.test(qf.reason)) {
      userMsg = "Network error reaching the swap API. Try again in a moment.";
    }

    void reply(pending.ctx, html(userMsg.slice(0, 300)));
  };

  const positionOwners = new Map<string, ReplyCtx>();
  const lastPnlNotify = new Map<string, number>();

  const onTradeExecutedForTracking = (
    pos: import("../shared/types").TradeExecutedPayload,
  ): void => {
    const pending = replyByRequestId.get(pos.intentId);
    if (pending) positionOwners.set(pos.positionId, pending.ctx);
  };

  const lastPnlValue = new Map<string, number>();
  const POSITION_NOTIFY_INTERVAL_MS = 3_600_000; // 1 hour
  const SIGNIFICANT_PNL_CHANGE_PCT = 5; // alert on 5%+ PnL shift since last notification

  const onWalletFunded = (payload: import("../shared/types").WalletFundedPayload): void => {
    const route = chatByEmail.get(payload.userId);
    if (!route) {
      // User has never spoken to the bot from this process — nothing to do.
      // The next interaction will rebuild the chat route.
      return;
    }
    const chainName = getChainName(payload.chainId);
    const symbol = payload.asset.kind === "native" ? payload.asset.symbol : payload.asset.symbol;
    const explorer = getChainExplorer(payload.chainId);
    const lines = [
      `<b>Wallet funded</b>`,
      ``,
      `+${payload.amountDisplay} ${html(symbol)} on ${html(chainName)}`,
      ``,
      `<a href="${explorer}/address/${payload.walletAddress}">${codeAddr(payload.walletAddress)}</a>`,
    ];
    void bot.api
      .sendMessage(route.chatId, lines.join("\n"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      })
      .catch((err) => {
        console.warn(
          `[telegram] WALLET_FUNDED notify failed for ${payload.userId}: ${(err as Error).message}`,
        );
      });
  };

  const onPositionUpdate = (update: PositionUpdate): void => {
    const owner = positionOwners.get(update.positionId);
    if (!owner) return;

    const lastSent = lastPnlNotify.get(update.positionId) ?? 0;
    const prevPnl = lastPnlValue.get(update.positionId) ?? 0;
    const pnlShift = Math.abs(update.pnlPct - prevPnl);
    const isSignificant = pnlShift >= SIGNIFICANT_PNL_CHANGE_PCT;
    const isScheduled = Date.now() - lastSent >= POSITION_NOTIFY_INTERVAL_MS;

    if (!isScheduled && !isSignificant) return;

    const sign = update.pnlPct >= 0 ? "+" : "";
    const pos = getPosition(update.positionId);
    const label = pos?.symbol ?? update.positionId.slice(0, 8) + "...";
    const priceStr =
      update.priceUsd >= 1 ? `$${update.priceUsd.toFixed(2)}` : `$${update.priceUsd.toFixed(6)}`;
    void reply(owner, `${label}  ${priceStr}  ${sign}${update.pnlPct.toFixed(1)}%`);
    lastPnlNotify.set(update.positionId, Date.now());
    lastPnlValue.set(update.positionId, update.pnlPct);
  };

  bus.on("TRADE_EXECUTED", onTradeExecutedForTracking);
  bus.on("TRADE_EXECUTED", onExecuted);
  bus.on("STRATEGY_DECISION", onStrategy);
  bus.on("SAFETY_RESULT", onSafety);
  bus.on("WALLET_FUNDED", onWalletFunded);
  bus.on("RESEARCH_RESULT", onResearchResult);
  bus.on("QUOTE_FAILED", onQuoteFailed);
  bus.on("POSITION_UPDATE", onPositionUpdate);

  // Per-user settings (in-memory, session-scoped)
  const userSettings = new Map<string, { mode: TradingMode; defaultAmount?: number }>();

  // /start — smart welcome: returning users get a dynamic LLM greeting
  bot.command("start", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const wallet = wm?.getWallet(userId) ?? undefined;
    const hasWallet = wallet != null;

    if (hasWallet && llm) {
      const positions = getPositionsByUser(userId);
      const config = wm!.getFullWalletConfig(userId);
      const mode = userSettings.get(userId)?.mode ?? "NORMAL";

      const context = [
        `Returning user. Wallet: ${wallet.address.slice(0, 8)}...`,
        `Mode: ${mode}. Open positions: ${positions.length}.`,
        config && config.externalWallets.length > 0
          ? `External wallets: ${config.externalWallets.length}.`
          : "",
        "Greet them warmly but briefly. Mention what they can do right now.",
        "Don't list commands. Be conversational, 2-3 sentences max.",
      ]
        .filter(Boolean)
        .join(" ");

      try {
        const resp = await llm.infer({
          system:
            CONVERSATIONAL_PROMPT +
            composeSkillsPrompt("gateway", getUserSkillOverrides(userId)) +
            "\n\nContext: " +
            context,
          user: "User just opened the bot.",
          temperature: 0.8,
          maxTokens: 150,
        });
        await ctx.reply(html(resp.text), { parse_mode: "HTML" });
        return;
      } catch (err) {
        console.warn("[telegram] LLM greeting failed:", (err as Error).message);
      }
    }

    await ctx.reply(
      [
        `<b>HAWKEYE</b>`,
        ``,
        `Trade, research, and track tokens across EVM chains.`,
        ``,
        `/wallet to get started`,
        `Paste any contract address to trade`,
        `/help for all commands`,
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
        `/wallet  Create or view wallet`,
        `/balance  Balances across chains`,
        `/positions  Open trades and PnL`,
        `/send  Transfer tokens`,
        `/mode  Trading mode (degen, normal, safe)`,
        `/watch  Copy a wallet's buys`,
        `/status  System health`,
        ``,
        `<b>Trade</b>`,
        `Paste a contract address`,
        `"Buy 0.01 ETH of PEPE on Base"`,
        `"Swap 0.1 ETH to USDC"`,
        `"Sell all PEPE"`,
        ``,
        `<b>Research</b>`,
        `"Is 0x... safe?"`,
        `"What's trending?"`,
        ``,
        `<b>Wallet</b>`,
        `<code>connect 0x...</code>  Link external wallet`,
        `<code>use 0x...</code>  Switch active wallet`,
        `<code>use agent wallet</code>  Back to HAWKEYE wallet`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("history", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const trades = getTradeHistory(userId, 10);
    if (trades.length === 0) {
      await ctx.reply("No trades yet. Start trading to build your history.", {
        parse_mode: "HTML",
      });
      return;
    }
    const lines = trades
      .slice()
      .reverse()
      .map((t) => {
        const side = t.side === "buy" ? "BUY" : "SELL";
        const sym = t.symbol ?? t.address.slice(0, 8) + "...";
        const price = t.priceUsd >= 1 ? `$${t.priceUsd.toFixed(2)}` : `$${t.priceUsd.toFixed(6)}`;
        const amt =
          t.filled.unit === "USD" ? `$${t.filled.value}` : `${t.filled.value} ${t.filled.unit}`;
        const explorer = getChainExplorer(t.chainId);
        const date = new Date(t.timestamp);
        const ts = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
        return `${ts}  ${side} ${html(sym)} ${amt} at ${price}\n<a href="${explorer}/tx/${t.txHash}">${t.txHash.slice(0, 12)}...</a>`;
      });
    await ctx.reply(`<b>Trade History</b> (last ${trades.length})\n\n${lines.join("\n\n")}`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  // /balance — show native token balances across chains
  bot.command("balance", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    if (!wm || !wm.getWallet(userId)) {
      await ctx.reply("You need a wallet first. Use /wallet to create one.", {
        parse_mode: "HTML",
      });
      return;
    }
    const config = wm.getWalletConfig(userId);
    const addr = config.activeAddress;
    if (!addr) {
      await ctx.reply("No active wallet found. Use /wallet to set one up.");
      return;
    }

    await ctx.reply(`Fetching balances for ${codeAddr(addr)}...`, { parse_mode: "HTML" });

    const chains = ["ethereum", "sepolia", "base", "arbitrum", "optimism", "polygon", "bsc"];

    // Build extra token list from tracked positions and seen tokens
    const userPositions = getPositionsByUser(userId);
    const seenTokens = getSeenTokens(userId);
    const extraSet = new Set<string>();
    const extraTokens: Array<{ address: string; chainId: string; symbol?: string | undefined }> =
      [];
    for (const p of userPositions) {
      const key = `${p.chainId}:${p.address.toLowerCase()}`;
      if (!extraSet.has(key)) {
        extraSet.add(key);
        extraTokens.push({ address: p.address, chainId: p.chainId, symbol: p.symbol });
      }
    }
    for (const s of seenTokens) {
      const key = `${s.chainId}:${s.address.toLowerCase()}`;
      if (!extraSet.has(key)) {
        extraSet.add(key);
        extraTokens.push({ address: s.address, chainId: s.chainId, symbol: s.symbol });
      }
    }

    // Fetch native balances and token holdings in parallel.
    // We include testnets (Sepolia) too — the well-known stable list won't
    // match anything there, but tracked positions and seen tokens still get
    // a balanceOf call so e.g. Sepolia USDC bought through the bot shows up.
    const [nativeResults, tokenData] = await Promise.all([
      Promise.all(
        chains.map(async (chain) => {
          const cfg = EVM_CHAIN_CONFIG[chain];
          const currency = cfg?.nativeCurrency ?? "ETH";
          const { balance, error } = await fetchNativeBalance(chain, addr);
          if (error) return { line: `  ${getChainName(chain)}: error`, usd: 0, hasBalance: false };
          const ethVal = Number(balance) / 1e18;
          if (ethVal > 0.00001) {
            const isTestnet = chain === "sepolia";
            let usdStr = "";
            let usd = 0;
            if (!isTestnet) {
              const price = await fetchNativePrice(currency);
              usd = ethVal * price;
              usdStr = usd >= 0.01 ? ` (~$${formatUsd(usd)})` : "";
            }
            return {
              line: `  ${getChainName(chain)}: ${ethVal.toFixed(6)} ${currency}${usdStr}`,
              usd,
              hasBalance: true,
            };
          }
          return { line: `  ${getChainName(chain)}: 0`, usd: 0, hasBalance: false };
        }),
      ),
      fetchTokenHoldings(addr, chains, 10_000, extraTokens),
    ]);

    const balanceLines = nativeResults.map((r) => r.line);
    const hasNativeBalance = nativeResults.some((r) => r.hasBalance);
    const nativeUsd = nativeResults.reduce((sum, r) => sum + r.usd, 0);

    const tokenLines: string[] = [];
    const nonNativeTokens = tokenData.assets.filter(
      (a) => a.tokenSymbol !== "ETH" && a.tokenSymbol !== "WETH" && parseFloat(a.balance) > 0,
    );
    for (const t of nonNativeTokens.slice(0, 15)) {
      tokenLines.push(`  ${t.tokenSymbol} (${getChainName(t.blockchain)}): ${t.balance}`);
    }

    const totalUsd = nativeUsd;

    const lines = [`<b>Balances</b>  ${codeAddr(addr)}`, ``, ...balanceLines];

    if (tokenLines.length > 0) {
      lines.push(``);
      lines.push(...tokenLines);
    }

    if (totalUsd >= 0.01) {
      lines.push(``, `Total ~$${formatUsd(totalUsd)}`);
    }
    if (!hasNativeBalance && tokenLines.length === 0) {
      lines.push(``, `No funds yet. Send ETH to your address to start.`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /link — tie existing wallet to a real email
  bot.command("link", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    if (!wm) {
      await ctx.reply("Wallet system not available.");
      return;
    }
    const emailArg = (ctx.match as string).trim();
    if (
      emailArg &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg) &&
      !emailArg.endsWith("@hawkeye.local")
    ) {
      try {
        const ok = await wm.linkEmail(userId, emailArg);
        if (ok) {
          await ctx.reply(
            `Wallet linked to <b>${emailArg}</b>.\nYour wallet is now recoverable via this email across any platform.`,
            { parse_mode: "HTML" },
          );
        } else {
          await ctx.reply("No wallet found to link. Use /wallet first.");
        }
      } catch (err) {
        await ctx.reply(`Link failed: ${(err as Error).message}`);
      }
      return;
    }
    pendingEmailPrompts.set(userId, { chatId: ctx.chat.id, action: "link" });
    await ctx.reply("Enter your email to link to your wallet profile:");
  });

  // /wallet — create on explicit request, show full multi-wallet info
  bot.command("wallet", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    if (!wm) {
      await ctx.reply("Wallet system not available.");
      return;
    }

    const existing = wm.getWallet(userId);
    if (!existing) {
      pendingEmailPrompts.set(userId, { chatId: ctx.chat.id, action: "create" });
      await ctx.reply("Enter your email to create your wallet.");
      return;
    }

    const full = wm.getFullWalletConfig(userId);
    if (!full) {
      await ctx.reply("No wallet profile found. Use /wallet to create one.");
      return;
    }

    const khOk = getHealth().subsystems.some((s) => s.name === "KeeperHub" && s.ok);
    const isSynthetic = full.email.endsWith("@hawkeye.local");
    const isAgentActive = full.activeWallet.kind === "agent";

    const lines: string[] = [`<b>Wallet</b>`];
    lines.push(``);

    if (full.agentWallet) {
      const tag = isAgentActive ? "  active" : "";
      lines.push(`EVM  ${codeAddr(full.agentWallet.address)}${tag}`);
    }
    const solWallet = wm.getSolanaWallet(userId);
    if (solWallet) {
      lines.push(`SOL  ${codeAddr(solWallet.address)}`);
    } else if (full.agentWallet) {
      void wm
        .ensureSolanaWallet(userId)
        .then((sw) => {
          if (sw) {
            void ctx.reply(`Solana wallet: ${codeAddr(sw.address)}`, { parse_mode: "HTML" });
          }
        })
        .catch(() => {});
    }

    if (full.externalWallets.length > 0) {
      lines.push(``);
      for (const ew of full.externalWallets) {
        const isActive =
          full.activeWallet.kind === "external" &&
          full.activeWallet.address.toLowerCase() === ew.address.toLowerCase();
        const tag = isActive ? "  active" : "";
        const delegation = ew.delegated ? "" : " (view-only)";
        lines.push(`${ew.label}  ${codeAddr(ew.address)}${tag}${delegation}`);
      }
    }

    const infoParts: string[] = [];
    if (!isSynthetic) infoParts.push(full.email);
    if (khOk) infoParts.push("MEV protected");
    if (infoParts.length) {
      lines.push(``);
      lines.push(infoParts.join("  "));
    }
    if (isSynthetic) {
      lines.push(``);
      lines.push(`/link to add email recovery`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /send — direct native token transfer
  bot.command("send", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const rctx: ReplyCtx = { chatId: ctx.chat.id, userId };
    const args = (ctx.match as string).trim().split(/\s+/);

    if (!wm) {
      await reply(rctx, "Wallet system not available.");
      return;
    }
    if (!wm.getWallet(userId)) {
      await reply(rctx, "You need a wallet first. Use /wallet to create one.");
      return;
    }
    if (args.length < 2) {
      await reply(
        rctx,
        "Usage: <code>/send &lt;amount&gt; [&lt;asset&gt;] &lt;recipient&gt; [chain]</code>\nExamples:\n<code>/send 0.01 0xABC... base</code>\n<code>/send 5 USDC 0xABC... base</code>",
      );
      return;
    }

    const amount = Number(args[0]);
    if (!Number.isFinite(amount) || amount <= 0) {
      await reply(rctx, `Invalid amount: ${html(args[0] ?? "")}`);
      return;
    }

    // Accept "/send 5 USDC 0xABC base" (asset between amount and recipient)
    // or the existing "/send 0.01 0xABC base" native form. We detect the asset
    // by looking at args[1]: if it's not a 0x address, treat it as a symbol.
    let asset: string | null = null;
    let recipientIdx = 1;
    if (!/^0x[a-fA-F0-9]{40}$/.test(args[1]!)) {
      asset = args[1]!.toUpperCase();
      recipientIdx = 2;
    }
    const recipient = args[recipientIdx];
    if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      await reply(rctx, "Invalid recipient address. Must be a 0x address (40 hex chars).");
      return;
    }

    const chainInput = args[recipientIdx + 1] ?? "ethereum";
    const chain = resolveChainNumeric(chainInput);
    if (!chain) {
      await reply(
        rctx,
        `Unknown chain: ${html(chainInput)}. Try: ethereum, base, arb, op, polygon, bsc, sepolia`,
      );
      return;
    }

    await executeSend(rctx, userId, recipient, amount, chain.name, chain.id, asset);
  });

  const pendingEmailPrompts = new Map<string, { chatId: number; action: "create" | "link" }>();

  const MODE_MAP: Record<string, TradingMode> = {
    degen: "INSTANT",
    instant: "INSTANT",
    normal: "NORMAL",
    safe: "CAREFUL",
    careful: "CAREFUL",
  };

  const MODE_DESC: Record<TradingMode, string> = {
    INSTANT: "Auto-execute. Honeypots ask for confirmation.",
    NORMAL: "Confirm below safety 70. Everything else auto-executes.",
    CAREFUL: "Confirm below 70 or any safety flags.",
  };

  // /mode — switch trading mode
  bot.command("mode", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const arg = (ctx.match as string).trim().toLowerCase();

    if (!arg) {
      const current = userSettings.get(userId)?.mode ?? "NORMAL";
      const friendlyName =
        current === "INSTANT" ? "degen" : current === "CAREFUL" ? "safe" : "normal";
      const defAmt = userSettings.get(userId)?.defaultAmount;
      await ctx.reply(
        [
          `<b>Mode: ${friendlyName}</b>`,
          MODE_DESC[current],
          defAmt ? `Default: ${defAmt} ETH` : ``,
          ``,
          `<code>/mode degen</code>  auto-execute`,
          `<code>/mode normal</code>  confirm risky`,
          `<code>/mode safe</code>  strict safety`,
          `<code>/mode amount 0.01</code>  set default`,
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    // /mode amount 0.01 — set default buy amount
    const amountMatch = arg.match(/^amount\s+([\d.]+)$/);
    if (amountMatch) {
      const val = parseFloat(amountMatch[1]!);
      if (!Number.isFinite(val) || val <= 0) {
        await ctx.reply("Invalid amount. Example: <code>/mode amount 0.01</code>", {
          parse_mode: "HTML",
        });
        return;
      }
      const existing = userSettings.get(userId);
      userSettings.set(userId, { mode: existing?.mode ?? "NORMAL", defaultAmount: val });
      await ctx.reply(`Default buy: ${val} ETH`, { parse_mode: "HTML" });
      return;
    }

    const mode = MODE_MAP[arg];
    if (!mode) {
      await ctx.reply(`Unknown mode: ${arg}. Try: degen, normal, safe, amount [number]`);
      return;
    }

    const existing = userSettings.get(userId);
    const defAmt = existing?.defaultAmount;
    const entry: { mode: TradingMode; defaultAmount?: number } = { mode };
    if (defAmt !== undefined) entry.defaultAmount = defAmt;
    userSettings.set(userId, entry);
    const friendlyName = mode === "INSTANT" ? "degen" : mode === "CAREFUL" ? "safe" : "normal";
    await ctx.reply(`Mode: ${friendlyName}. ${MODE_DESC[mode]}`, { parse_mode: "HTML" });
  });

  bot.command("skills", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const arg = (ctx.match as string).trim().toLowerCase();
    const overrides = getUserSkillOverrides(userId);
    const all = listSkills();

    if (!arg) {
      const lines = [`<b>HAWKEYE Skills</b>`, ``];
      for (const s of all) {
        const effective = overrides[s.id] ?? s.enabled;
        const dot = effective ? "🟢" : "⚪";
        lines.push(`${dot} <code>${s.id}</code> · <i>p${s.priority}</i> — ${html(s.description)}`);
      }
      lines.push(
        ``,
        `<code>/skills on &lt;id&gt;</code>  enable a skill`,
        `<code>/skills off &lt;id&gt;</code>  disable a skill`,
      );
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    const m = arg.match(/^(on|off)\s+(\S+)$/);
    if (!m) {
      await ctx.reply(
        "Usage: <code>/skills</code>, <code>/skills on rug-detector</code>, <code>/skills off degen-trader</code>",
        { parse_mode: "HTML" },
      );
      return;
    }
    const enable = m[1] === "on";
    const id = m[2]!;
    const found = all.find((s) => s.id === id);
    if (!found) {
      await ctx.reply(
        `Unknown skill: <code>${html(id)}</code>. Run <code>/skills</code> to list.`,
        {
          parse_mode: "HTML",
        },
      );
      return;
    }
    setUserSkillOverride(userId, id, enable);
    await ctx.reply(
      `${enable ? "Enabled" : "Disabled"}: <b>${html(found.name)}</b> (priority ${found.priority})`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("llm", async (ctx) => {
    if (!llm) {
      await ctx.reply("No LLM configured.");
      return;
    }
    const arg = (ctx.match as string).trim().toLowerCase();
    if (arg === "reset") {
      llm.resetPrimary();
      await ctx.reply(
        "0G Compute primary state reset. Next inference will re-probe 0G; if it fails the fallback takes over for the next 5 minutes.",
      );
      return;
    }
    const s = llm.status();
    const lines: string[] = [`<b>LLM routing</b>`, ``];
    if (s.activePath === "primary") {
      lines.push(`🟢 Active: <b>0G Compute</b> (sealed inference, primary)`);
    } else if (s.activePath === "fallback") {
      lines.push(`🟡 Active: <b>${html(s.fallbackName ?? "fallback")}</b>`);
      if (s.suppressedForMs > 0) {
        const secs = Math.ceil(s.suppressedForMs / 1000);
        lines.push(`   0G suppressed for ${secs}s after a failure; auto re-probes after that.`);
      }
    } else {
      lines.push(`🔴 No LLM available.`);
    }
    lines.push(``, `<b>Configured</b>:`);
    lines.push(`• 0G Compute: ${s.primaryConfigured ? "yes" : "no"}`);
    lines.push(`• Fallback (OpenRouter/Claude): ${s.fallbackConfigured ? "yes" : "no"}`);
    if (s.activePath !== "primary" && s.primaryConfigured) {
      lines.push(``, `<code>/llm reset</code> forces an immediate 0G re-probe.`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /watch — add wallet to copy-trade watch list
  bot.command("watch", async (ctx) => {
    const args = (ctx.match as string).trim().split(/\s+/);
    const address = args[0] ?? "";
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      await ctx.reply(
        "Usage: <code>/watch 0xABC... [label]</code>\nExample: <code>/watch 0x1234...ABCD whale1</code>",
        { parse_mode: "HTML" },
      );
      return;
    }
    const labelText = args.slice(1).join(" ");
    const wallet: import("../shared/types").WatchedWallet = { address, chain: "evm" };
    if (labelText) wallet.label = labelText;
    bus.emit("ADD_WATCHED_WALLET", wallet);
    await ctx.reply(
      `Watching ${codeAddr(address)}${labelText ? ` (${html(labelText)})` : ""}.\nI'll copy their buys automatically through the safety pipeline.`,
      { parse_mode: "HTML" },
    );
  });

  // /unwatch — remove wallet from watch list
  bot.command("unwatch", async (ctx) => {
    const address = (ctx.match as string).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      await ctx.reply("Usage: <code>/unwatch 0xABC...</code>", { parse_mode: "HTML" });
      return;
    }
    bus.emit("REMOVE_WATCHED_WALLET", address);
    await ctx.reply(`Stopped watching ${codeAddr(address)}.`, { parse_mode: "HTML" });
  });

  // /watchlist — show watched wallets
  bot.command("watchlist", async (ctx) => {
    const addresses = getWatchedWalletAddresses();
    if (addresses.length === 0) {
      await ctx.reply(
        "No wallets being watched.\nUse <code>/watch 0xABC... [label]</code> to start copy trading.",
        { parse_mode: "HTML" },
      );
      return;
    }
    const lines = ["<b>Watched Wallets</b>\n"];
    for (const addr of addresses) {
      lines.push(`  ${codeAddr(addr)}`);
    }
    lines.push(`\nTotal: ${addresses.length}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // /positions — show open positions with PnL
  bot.command("positions", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const positions = getPositionsByUser(userId);
    if (positions.length === 0) {
      await ctx.reply("No open positions. Paste a contract address to start trading.");
      return;
    }
    const lines = [`<b>Positions</b> (${positions.length})\n`];
    for (const pos of positions) {
      const label = pos.symbol ?? pos.address.slice(0, 8) + "...";
      const chain = getChainName(pos.chainId);
      const age = Math.round((Date.now() - pos.openedAt) / 60_000);
      const ageStr = age < 60 ? `${age}m` : `${Math.round(age / 60)}h`;
      const priceStr =
        pos.entryPriceUsd >= 1
          ? `$${pos.entryPriceUsd.toFixed(2)}`
          : `$${pos.entryPriceUsd.toFixed(6)}`;
      lines.push(
        `<b>${html(label)}</b> on ${chain}`,
        `${pos.filled.value} ${pos.filled.unit} at ${priceStr}  ${ageStr} ago`,
        ``,
      );
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // Callback query handler — inline keyboard confirmations
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const rctx: ReplyCtx = { chatId, userId };

    // research:{address} — trigger research for a token from trending
    const researchMatch = data.match(/^research:(.+)$/);
    if (researchMatch) {
      const addr = researchMatch[1]!;
      await ctx.answerCallbackQuery({ text: "Researching..." });
      const requestId = randomUUID();
      replyByRequestId.set(requestId, { ctx: rctx, rootHash: null });
      const cachedChain = trendingChainCache.get(addr.toLowerCase());
      bus.emit("RESEARCH_REQUEST", {
        requestId,
        userId,
        channel: "telegram" as MessageChannel,
        address: addr,
        tokenName: null,
        chain: null,
        question: `Research ${addr}`,
        rawText: cachedChain ? `research ${addr} on ${cachedChain}` : `research ${addr}`,
        createdAt: Date.now(),
      });
      void reply(rctx, `Looking up ${codeAddr(addr)}...`);
      return;
    }

    // buy:{address}:{chain} — start trade from research card
    const buyMatch = data.match(/^buy:(.+):(evm|solana)$/);
    if (buyMatch) {
      const addr = buyMatch[1]!;
      const chain = buyMatch[2]! as ChainClass;
      await ctx.answerCallbackQuery({ text: "Setting up trade..." });

      // Resolve specific chain (e.g. "base") via DexScreener lookup or cache
      const lastRes = lastResearchByUser.get(userId);
      const specificChain =
        lastRes?.specificChain ?? trendingChainCache.get(addr.toLowerCase()) ?? null;
      const symbol = lastRes?.symbol ?? addr.slice(0, 10);

      const defaultAmount = userSettings.get(userId)?.defaultAmount;
      if (!defaultAmount || defaultAmount <= 0) {
        pendingBuyByUser.set(userId, {
          address: addr,
          chain,
          specificChain: specificChain ?? "ethereum",
          symbol,
          at: Date.now(),
        });
        void reply(
          rctx,
          [
            `How much do you want to buy?`,
            ``,
            `Reply with an amount, for example:`,
            `  <code>buy 0.01 ETH of ${addr.slice(0, 10)}...</code>`,
            `  <code>buy $20 of ${addr.slice(0, 10)}...</code>`,
            ``,
            `Or set a default: <code>/mode amount 0.01</code>`,
          ].join("\n"),
        );
        return;
      }

      const intentId = randomUUID();
      replyByRequestId.set(intentId, { ctx: rctx, rootHash: null });
      const mode = userSettings.get(userId)?.mode ?? "NORMAL";
      const chainHintSnipe = specificChain ?? (chain === "evm" ? "ethereum" : chain);
      trackToken(userId, addr, chainHintSnipe, symbol);
      bus.emit("TRADE_REQUEST", {
        intentId,
        userId,
        channel: "telegram" as MessageChannel,
        address: addr,
        chain,
        amount: { value: defaultAmount, unit: "NATIVE" } as TradeAmount,
        exits: [],
        urgency: mode as TradingMode,
        rawText: `buy ${addr}`,
        createdAt: Date.now(),
        symbol,
      });
      void reply(rctx, `Buying ${defaultAmount} ETH of ${codeAddr(addr)}...`);
      return;
    }

    // confirm/reject trade
    const confirmMatch = data.match(/^(confirm|reject):(.+)$/);
    if (!confirmMatch) {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }

    const action = confirmMatch[1]!;
    const intentId = confirmMatch[2]!;
    const pc = pendingConfirmations.get(intentId);

    if (!pc) {
      await ctx.answerCallbackQuery({ text: "This confirmation has expired." });
      return;
    }

    pendingConfirmations.delete(intentId);
    clearTimeout(pc.timer);

    const confirmed = action === "confirm";
    bus.emit("USER_CONFIRMED", { intentId, confirmed, userId, at: Date.now() });

    const statusText = confirmed ? "Trade confirmed. Executing..." : "Trade rejected.";
    await ctx.answerCallbackQuery({ text: statusText });

    if (pc.messageId) {
      void bot.api
        .editMessageText(pc.ctx.chatId, pc.messageId, `<b>${statusText}</b>`, {
          parse_mode: "HTML",
        })
        .catch(() => {});
    }
  });

  // Message handler
  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const text = ctx.message.text;
    const rctx: ReplyCtx = { chatId: ctx.chat.id, userId };
    const lower = text.trim().toLowerCase();

    // Skip slash commands — already handled by bot.command() handlers
    if (text.startsWith("/")) return;

    addMessage(userId, "user", text);

    // Email input for wallet creation / link
    const pendingEmail = pendingEmailPrompts.get(userId);
    if (pendingEmail && wm) {
      pendingEmailPrompts.delete(userId);
      const emailInput = text.trim().toLowerCase();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput) || emailInput.endsWith("@hawkeye.local")) {
        await ctx.reply("That doesn't look like a valid email. Try /wallet again.");
        return;
      }

      if (pendingEmail.action === "create") {
        try {
          const wallet = await wm.createWalletWithEmail(userId, emailInput);
          const solWallet = await wm.ensureSolanaWallet(userId);
          const lines = [`<b>Wallet created</b>`, ``, `EVM  ${codeAddr(wallet.address)}`];
          if (solWallet) {
            lines.push(`SOL  ${codeAddr(solWallet.address)}`);
          }
          lines.push(``, `${emailInput}`, ``, `Send ETH to your EVM address to start trading.`);
          await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });

          await ctx.reply(
            [
              `<b>This is your HAWKEYE agent wallet.</b>`,
              ``,
              `Trade, swap, and send straight from chat — HAWKEYE handles the on-chain work for you.`,
            ].join("\n"),
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
          );
        } catch (err) {
          await ctx.reply(`Failed to create wallet: ${(err as Error).message}`);
        }
      } else {
        try {
          const ok = await wm.linkEmail(userId, emailInput);
          if (ok) {
            await ctx.reply(
              `Wallet linked to <b>${emailInput}</b>.\nRecoverable across all platforms.`,
              { parse_mode: "HTML" },
            );
          } else {
            await ctx.reply("No wallet found to link. Use /wallet first.");
          }
        } catch (err) {
          await ctx.reply(`Link failed: ${(err as Error).message}`);
        }
      }
      return;
    }

    // Wallet connect command: connect 0x... [label]
    const connectMatch = text.trim().match(/^(?:connect|link)\s+(0x[a-fA-F0-9]{40})(?:\s+(.+))?$/i);
    if (wm && connectMatch) {
      const addr = connectMatch[1]!;
      const label = connectMatch[2]?.trim();
      wm.connectExternalWallet(userId, addr, label);
      await ctx.reply(
        [
          `Wallet connected: ${codeAddr(addr)}${label ? ` (${label})` : ""}`,
          `\nNow active for trades. Say <code>use agent wallet</code> to switch back.`,
          `Use <code>/wallet</code> to see all connected wallets.`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    // Disconnect wallet: disconnect 0x...
    const disconnectMatch = text.trim().match(/^disconnect\s+(0x[a-fA-F0-9]{40})$/i);
    if (wm && disconnectMatch) {
      const addr = disconnectMatch[1]!;
      const ok = wm.disconnectExternalWallet(userId, addr);
      if (ok) {
        await ctx.reply(`Wallet disconnected: ${codeAddr(addr)}\nSwitched to agent wallet.`, {
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply(`Wallet ${codeAddr(addr)} is not connected.`, { parse_mode: "HTML" });
      }
      return;
    }

    // Use specific address: use 0x...
    const useAddrMatch = lower.match(/^use\s+(0x[a-fA-F0-9]{40})$/i);
    if (wm && useAddrMatch) {
      const ok = wm.setActiveWallet(userId, { kind: "external", address: useAddrMatch[1]! });
      if (ok) {
        await ctx.reply(`Active wallet: ${codeAddr(useAddrMatch[1]!)}`, { parse_mode: "HTML" });
      } else {
        await ctx.reply(`That wallet is not connected. Use <code>connect 0x...</code> first.`, {
          parse_mode: "HTML",
        });
      }
      return;
    }

    if (wm && (lower === "use agent wallet" || lower === "use hawkeye wallet")) {
      wm.setActiveWallet(userId, { kind: "agent" });
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
      const full = wm.getFullWalletConfig(userId);
      if (full && full.externalWallets.length > 0) {
        const first = full.externalWallets[0]!;
        wm.setActiveWallet(userId, { kind: "external", address: first.address });
        await ctx.reply(`Switched to: ${codeAddr(first.address)} (${first.label})`, {
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply(
          `No external wallet connected. Say <code>connect 0x... [label]</code> to link one.`,
          { parse_mode: "HTML" },
        );
      }
      return;
    }

    // Intercept follow-up amounts for pending buy context (from inline keyboard)
    const pendingBuy = pendingBuyByUser.get(userId);
    if (pendingBuy && Date.now() - pendingBuy.at < 300_000) {
      const amtMatch = text.match(/^\$?([\d.]+)\s*(?:\$|usd|worth|eth)?/i);
      if (amtMatch) {
        pendingBuyByUser.delete(userId);
        const rawVal = parseFloat(amtMatch[1]!);
        if (rawVal > 0) {
          const isUsd = /\$|usd|worth/i.test(text);
          const syntheticResult: RouterResult = {
            id: randomUUID(),
            category: "TRADE",
            confidence: 1,
            rawText: text,
            userId,
            channel: "telegram" as MessageChannel,
            routedAt: Date.now(),
            data: {
              address: pendingBuy.address,
              chain: pendingBuy.specificChain ?? pendingBuy.chain,
              side: "buy",
              amount: isUsd ? { value: rawVal, unit: "USD" } : { value: rawVal, unit: "NATIVE" },
              toToken: pendingBuy.symbol,
            },
          };
          console.log(
            `[telegram] pendingBuy intercepted — user=${userId} amount=${rawVal} ${isUsd ? "USD" : "NATIVE"} token=${pendingBuy.symbol}`,
          );
          return handleTrade(syntheticResult, rctx, storage, replyByRequestId, wm, userId);
        }
      }
      if (Date.now() - pendingBuy.at >= 300_000) pendingBuyByUser.delete(userId);
    }

    // Route through LLM router
    const routerDeps = llm !== null ? { llm: llm as unknown as OgComputeClient } : {};
    const result = await routeMessage(
      { text, userId, channel: "telegram" as MessageChannel },
      routerDeps,
    );

    console.log(
      `[telegram] user=${userId} category=${result.category} confidence=${result.confidence.toFixed(2)} len=${text.length}`,
    );

    switch (result.category) {
      case "DEGEN_SNIPE":
      case "TRADE":
        return handleTrade(result, rctx, storage, replyByRequestId, wm, userId);
      case "SEND_TOKEN":
        return handleSendToken(result, rctx, wm, userId);
      case "RESEARCH_TOKEN":
        return handleResearch(result, rctx, replyByRequestId);
      case "RESEARCH_WALLET":
        return handleResearchWallet(result, rctx);
      case "COPY_TRADE":
        return handleCopyTrade(result, rctx);
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

  async function handleSendToken(
    result: RouterResult,
    rctx: ReplyCtx,
    walletMgr: WalletManager | null,
    userId: string,
  ): Promise<void> {
    if (!walletMgr || !walletMgr.getWallet(userId)) {
      void llmReply(
        rctx,
        result.rawText,
        "The user wants to send tokens but has no wallet. Tell them to use /wallet first.",
        "You need a wallet first. Use /wallet to create one.",
      );
      return;
    }

    const d = result.data;
    const recipient = typeof d["recipient"] === "string" ? d["recipient"] : null;
    if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      void llmReply(
        rctx,
        result.rawText,
        "The user wants to send tokens but the recipient address is missing or invalid. Ask them for a valid 0x address. They can also use /send <amount> <address> [chain].",
        "I need a valid recipient address. Try: /send 0.01 0xABC... base",
      );
      return;
    }

    const amountRaw = d["amount"] as Record<string, unknown> | null | undefined;
    let amount = 0;
    let amountUnit: "NATIVE" | "USD" | "TOKEN" | "PERCENT" = "NATIVE";
    if (amountRaw && typeof amountRaw === "object") {
      const v = typeof amountRaw["value"] === "number" ? amountRaw["value"] : 0;
      amount = Number.isFinite(v) && v > 0 ? v : 0;
      const u = amountRaw["unit"];
      if (u === "USD" || u === "TOKEN" || u === "PERCENT") amountUnit = u;
    }
    if (amount <= 0) {
      const raw = result.rawText;
      // "9.2$" (dollar suffix) → USD; "$9.2" (prefix) is already caught by the
      // LLM router's regex but the suffix form isn't, so check it here too.
      const usdSuffix = raw.match(/([\d.]+)\s*\$/);
      const ethMatch = raw.match(/([\d.]+)\s*(?:\w+\s+)?(?:ETH|eth|ether)/i);
      const plainNum = raw.match(/([\d.]+)/);
      if (usdSuffix) {
        amount = parseFloat(usdSuffix[1]!);
        amountUnit = "USD";
      } else if (ethMatch) {
        amount = parseFloat(ethMatch[1]!);
      } else if (plainNum) {
        amount = parseFloat(plainNum[1]!);
      }
    }
    // Even after the LLM has answered, override unit to USD when the user's
    // raw text has a dollar sign next to a number. The LLM frequently returns
    // unit: "NATIVE" for "9.2$ ETH" — it locks onto the "ETH" symbol and
    // discards the "$" — but the user's literal "$" is the reliable signal.
    if (amountUnit === "NATIVE" && /(?:\$\s*\d|\d\s*\$)/.test(result.rawText)) {
      console.log(
        `[telegram] send: USD override fired (LLM returned NATIVE but text has $) — value=${amount}`,
      );
      amountUnit = "USD";
    }
    if (amount <= 0) {
      void llmReply(
        rctx,
        result.rawText,
        "The user wants to send tokens but didn't specify an amount. Ask how much they want to send.",
        "How much do you want to send? Try: /send 0.01 0xABC... base",
      );
      return;
    }

    const chainHint = typeof d["chain"] === "string" ? d["chain"] : "ethereum";
    const chain = resolveChainNumeric(chainHint);
    if (!chain) {
      void reply(
        rctx,
        `Unknown chain: ${html(chainHint)}. Try: ethereum, base, arb, op, polygon, bsc, sepolia`,
      );
      return;
    }

    // The LLM puts the source token in `asset`. The regex fallback path in the
    // router doesn't extract it, so also scan the raw text for a stablecoin
    // ticker (covers the typo'd "udsc" case from real-world testing too).
    let asset = typeof d["asset"] === "string" ? d["asset"] : null;
    if (!asset) {
      const tickerMatch = result.rawText.match(/\b(usdc|usdt|dai|udsc)\b/i);
      if (tickerMatch) asset = tickerMatch[1]!.toLowerCase() === "udsc" ? "USDC" : tickerMatch[1]!;
    }

    // Heuristic: when the LLM says NATIVE but the amount is wildly more than
    // the wallet can hold AND fits within the wallet as a USD figure, infer
    // USD intent. Patrick's "send 9.2 base ETH" with a $9.32 wallet means
    // $9.2, not 9.2 ETH (~$21k) — colloquial usage where users type the
    // dollar value next to the asset name without a $ sign.
    const STABLE_ASSETS = new Set(["USDC", "USDT", "DAI", "BUSD"]);
    const upperAssetEarly = asset?.toUpperCase() ?? null;
    const isErc20Early =
      upperAssetEarly !== null && !["ETH", "BNB", "MATIC", "AVAX", "POL"].includes(upperAssetEarly);
    if (amountUnit === "NATIVE" && !isErc20Early && walletMgr.walletAddress(userId)) {
      const walletAddr = walletMgr.walletAddress(userId)!;
      const { balance: nativeBal, error: balErr } = await fetchNativeBalance(
        chain.name,
        walletAddr,
        5_000,
      );
      if (!balErr) {
        const nativeCcy = EVM_CHAIN_CONFIG[chain.name]?.nativeCurrency ?? "ETH";
        const price = await fetchNativePrice(nativeCcy);
        if (price > 0) {
          const balanceNative = Number(nativeBal) / 1e18;
          const balanceUsd = balanceNative * price;
          const wantUsdIfNative = amount * price;
          // Trigger when (a) interpreting amount as native costs >3× the wallet's
          // USD value (impossible) AND (b) interpreting it as USD fits within
          // 1.1× the wallet (plausible). The 3× margin avoids false positives
          // on close-to-balance native sends.
          if (wantUsdIfNative > balanceUsd * 3 && amount <= balanceUsd * 1.1) {
            console.log(
              `[telegram] send: NATIVE→USD inferred — amount=${amount} ${nativeCcy} would cost $${wantUsdIfNative.toFixed(2)} but wallet has $${balanceUsd.toFixed(2)}; treating as $${amount}`,
            );
            amountUnit = "USD";
          }
        }
      }
    }

    // Convert USD → native amount. "$9.2 of ETH" needs the live ETH price;
    // "$5 of USDC/USDT/DAI" is ~1:1 against USD. For non-stable ERC-20s we
    // don't have a generic price source on the gateway side, so we punt with
    // a helpful message rather than guessing.
    if (amountUnit === "USD") {
      if (isErc20Early && upperAssetEarly && STABLE_ASSETS.has(upperAssetEarly)) {
        // $9 USDC → 9 USDC, near enough for stables.
      } else if (!isErc20Early) {
        const nativeCcy = EVM_CHAIN_CONFIG[chain.name]?.nativeCurrency ?? "ETH";
        const price = await fetchNativePrice(nativeCcy);
        if (price <= 0) {
          void reply(
            rctx,
            `Couldn't fetch ${html(nativeCcy)} price right now. Specify the amount in ${html(nativeCcy)} directly: <code>/send 0.01 0xABC... ${html(chain.name)}</code>`,
          );
          return;
        }
        amount = amount / price;
      } else {
        void reply(
          rctx,
          `Sending dollar amounts of ${html(upperAssetEarly!)} isn't supported yet. Specify the token amount instead.`,
        );
        return;
      }
    }

    await executeSend(rctx, userId, recipient, amount, chain.name, chain.id, asset);
  }

  async function executeSend(
    rctx: ReplyCtx,
    userId: string,
    recipient: string,
    amount: number,
    chainName: string,
    chainId: number,
    asset: string | null,
  ): Promise<void> {
    if (!wm) {
      void reply(rctx, "Wallet system not available.");
      return;
    }

    const explorer = getChainExplorer(chainName);
    const NATIVE_SEND_SYMBOLS = new Set(["ETH", "BNB", "MATIC", "AVAX", "POL"]);
    const upperAsset = asset?.toUpperCase() ?? null;
    const isErc20Send = upperAsset !== null && !NATIVE_SEND_SYMBOLS.has(upperAsset);

    // Resolve token contract for ERC-20 sends. Well-known stables first, then
    // fall back to the user's positions / seen tokens for less common tokens.
    let tokenContract: string | null = null;
    let tokenDecimals = 18;
    let tokenSymbol = upperAsset ?? "";
    if (isErc20Send) {
      const known = findWellKnownToken(chainName, upperAsset!);
      if (known) {
        tokenContract = known.address;
        tokenDecimals = known.decimals;
        tokenSymbol = known.symbol;
      } else {
        const positionMatch = getPositionsByUser(userId).find(
          (p) => p.chainId === chainName && p.symbol?.toUpperCase() === upperAsset,
        );
        if (positionMatch) {
          tokenContract = positionMatch.address;
          tokenSymbol = positionMatch.symbol ?? upperAsset!;
          tokenDecimals = await fetchTokenDecimals(chainName, positionMatch.address);
        } else {
          const seenMatch = getSeenTokens(userId).find(
            (t) => t.chainId === chainName && t.symbol?.toUpperCase() === upperAsset,
          );
          if (seenMatch) {
            tokenContract = seenMatch.address;
            tokenSymbol = seenMatch.symbol ?? upperAsset!;
            tokenDecimals = await fetchTokenDecimals(chainName, seenMatch.address);
          }
        }
      }
      if (!tokenContract) {
        void reply(
          rctx,
          `Couldn't find ${html(upperAsset!)} on ${html(chainName)}. Paste the token address or pick a different chain.`,
        );
        return;
      }
    }

    // Pre-flight balance check. The bot was previously submitting transactions
    // even when the wallet held zero on the target chain — Privy still returned
    // a hash that the user saw as success, but the tx would never confirm.
    // Reject up front with a clear "have X, want Y" message instead.
    const walletAddress = wm.walletAddress(userId);
    if (walletAddress) {
      if (isErc20Send) {
        const { balance, error } = await fetchTokenBalance(
          chainName,
          tokenContract!,
          walletAddress,
          5_000,
        );
        if (!error) {
          const wantRaw = tokenAmountToRaw(amount, tokenDecimals);
          if (balance < wantRaw) {
            const haveDisplay = Number(balance) / 10 ** tokenDecimals;
            void reply(
              rctx,
              `Not enough ${html(tokenSymbol)} on ${html(chainName)}: balance ${haveDisplay.toFixed(4)}, want ${amount}.`,
            );
            return;
          }
        }
      } else {
        const { balance, error } = await fetchNativeBalance(chainName, walletAddress, 5_000);
        if (!error) {
          // Gas reserve is chain-specific. Mainnet 21k transfer at 50 gwei is
          // ~0.0011 ETH so 0.0015 gives a safety margin. L2 transfers are
          // ~0.0000001 ETH; a 0.0015 reserve there would refuse legit sends
          // that fit the wallet (this was Patrick's Base $9 of $9.30 case).
          const GAS_RESERVE_WEI = nativeGasReserveWei(chainName);
          const wantWei = BigInt(nativeToWei(amount));
          if (balance < wantWei + GAS_RESERVE_WEI) {
            const haveNative = Number(balance) / 1e18;
            const reserveNative = Number(GAS_RESERVE_WEI) / 1e18;
            const maxSendable = Math.max(0, haveNative - reserveNative);
            const nativeCcy = EVM_CHAIN_CONFIG[chainName]?.nativeCurrency ?? "ETH";
            void reply(
              rctx,
              `Not enough ${html(nativeCcy)} on ${html(chainName)}: balance ${haveNative.toFixed(6)}, need ${amount} + ${reserveNative.toFixed(6)} gas. Max sendable: ${maxSendable.toFixed(6)} ${html(nativeCcy)}.`,
            );
            return;
          }
        }
      }
    }

    // Contract-recipient guard. Skip for ERC-20 sends because the destination
    // for an ERC-20 transfer() call is the *token contract*, not the recipient,
    // and many recipients (e.g. multisigs, smart wallets) are themselves
    // contracts that legitimately receive tokens.
    if (!isErc20Send) {
      try {
        const rpc = getChainRpc(chainName);
        const codeResp = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getCode",
            params: [recipient, "latest"],
          }),
        });
        const codeResult = (await codeResp.json()) as { result?: string };
        if (codeResult.result && codeResult.result !== "0x" && codeResult.result.length > 2) {
          void reply(
            rctx,
            [
              `That address is a <b>contract</b>, not a wallet.`,
              `Sending native tokens to a contract may result in permanent loss.`,
              ``,
              `If you meant to trade this token, just paste the address by itself.`,
              `If you really want to send to this contract, use your wallet app directly.`,
            ].join("\n"),
          );
          return;
        }
      } catch {
        // RPC check failed — proceed with warning
        console.warn(`[telegram] eth_getCode check failed for ${recipient} on ${chainName}`);
      }
    }

    const amountLabel = isErc20Send ? `${amount} ${tokenSymbol}` : `${amount}`;
    await reply(
      rctx,
      [
        `<b>Sending transaction</b>`,
        `To: ${codeAddr(recipient)}`,
        `Amount: ${html(amountLabel)}`,
        `Chain: ${html(chainName)} (${chainId})`,
        `\nSubmitting...`,
      ].join("\n"),
    );

    try {
      const txInput = isErc20Send
        ? {
            to: tokenContract!,
            value: "0",
            data: encodeErc20Transfer(recipient, tokenAmountToRaw(amount, tokenDecimals)),
            chainId,
            // ERC-20 transfers cost ~50k. Add headroom for tokens with hooks
            // (USDT, fee-on-transfer). Cheaper than a 21k native gas estimate
            // failure and still well below mainnet block limits.
            gasLimit: "100000",
          }
        : {
            to: recipient,
            value: nativeToWei(amount),
            chainId,
            gasLimit: "21000",
          };
      const result = await wm.sendTransaction(userId, txInput);
      void reply(
        rctx,
        [
          `<b>Transaction Sent</b>`,
          `Hash: ${codeAddr(result.hash)}`,
          `Chain: ${html(chainName)}`,
          `<a href="${explorer}/tx/${result.hash}">View on Explorer</a>`,
        ].join("\n"),
      );
    } catch (err) {
      void reply(rctx, `Transaction failed: ${html((err as Error).message)}`);
    }
  }

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
      const history = recentHistory(rctx.userId);
      const resp = await llm.infer({
        system:
          CONVERSATIONAL_PROMPT +
          composeSkillsPrompt("gateway", getUserSkillOverrides(rctx.userId)) +
          history +
          "\n\nContext for this reply: " +
          context,
        user: userMsg,
        temperature: 0.7,
        maxTokens: 300,
      });
      void reply(rctx, html(resp.text), "HTML");
    } catch {
      void reply(rctx, fallbackText);
    }
  }

  async function resolveSwapSource(
    symbol: string,
    chainHint: string | null,
    userId: string,
  ): Promise<{ address: string; chain: string } | null> {
    const upper = symbol.toUpperCase();
    // 1. Check positions (user actually holds this token)
    const positions = getPositionsByUser(userId);
    const posMatch = positions.find((p) => p.symbol?.toUpperCase() === upper);
    if (posMatch) return { address: posMatch.address, chain: posMatch.chainId };

    // 2. Check seen tokens — prefer most recently seen if multiple chains
    const seenTokens = getSeenTokens(userId);
    const seenMatches = seenTokens
      .filter((t) => t.symbol?.toUpperCase() === upper)
      .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
    if (seenMatches.length > 0) {
      const best = seenMatches[0]!;
      return { address: best.address, chain: best.chainId };
    }

    // 3. Known tokens / DexScreener
    const hint = chainHint && chainHint !== "evm" && chainHint !== "solana" ? chainHint : undefined;
    const resolved = await resolveToken(symbol, hint);
    if (resolved) return { address: resolved.address, chain: resolved.chain };
    return null;
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
    let toToken = typeof d["toToken"] === "string" ? d["toToken"] : null;
    const chainHint = typeof d["chain"] === "string" ? d["chain"] : null;

    if (chain === "solana" || chainHint === "solana") {
      void reply(
        rctx,
        "Solana trading is not supported yet. HAWKEYE currently works on EVM chains only (Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Sepolia).",
      );
      return;
    }

    if (toToken) {
      toToken = toToken.replace(/[^a-zA-Z0-9]/g, "");
      if (!toToken) toToken = null;
    }

    const WRAPPED_NATIVES = new Set([
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "0x4200000000000000000000000000000000000006",
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
      "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
      "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
    ]);
    if (address && WRAPPED_NATIVES.has(address.toLowerCase())) {
      address = null;
    }

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
    const rawSide = typeof d["side"] === "string" ? d["side"] : "buy";
    let sideHint: "buy" | "sell" | "swap" =
      rawSide === "sell" ? "sell" : rawSide === "swap" ? "swap" : "buy";

    // Native tokens that Uniswap wraps automatically — user says "ETH" but means native
    const NATIVE_SYMBOLS = new Set([
      "ETH",
      "WETH",
      "BNB",
      "WBNB",
      "MATIC",
      "WMATIC",
      "AVAX",
      "WAVAX",
    ]);

    // Swap logic: "swap X to Y"
    // Three cases:
    //   1. native → token: BUY target with native currency
    //   2. token → native: SELL source token for native
    //   3. token → token: BUY target, paying with source (token-to-token via Uniswap routing)
    let fromTokenAddress: string | null = null;
    let swapFromTokenAmount = false;
    // For "swap USDC to ETH" we re-point toToken=fromToken below so positions
    // are labelled with the source token. That clobbers the original target,
    // so capture it here for the user-facing confirm message.
    let swapNativeTarget: string | null = null;
    if (sideHint === "swap" && fromToken && toToken) {
      const fromUpper = fromToken.toUpperCase();
      const toUpper = toToken.toUpperCase();

      if (NATIVE_SYMBOLS.has(fromUpper)) {
        // "swap ETH to USDC" = buy USDC with ETH
        sideHint = "buy";
        hlog.agent(
          "gateway",
          `swap: "${fromToken} → ${toToken}" treated as BUY ${toToken} (paying with native ${fromToken})`,
        );
      } else if (NATIVE_SYMBOLS.has(toUpper)) {
        // "swap USDC to ETH" = sell USDC for native — amount is in fromToken terms
        const fromAddr = await resolveSwapSource(fromToken, chainHint, userId);
        if (fromAddr) {
          address = fromAddr.address;
          resolvedChainName = fromAddr.chain;
          chain = fromAddr.chain === "solana" ? "solana" : "evm";
        }
        sideHint = "sell";
        // Mark that amount is in source token units, not native ETH
        swapFromTokenAmount = true;
        // Remember the user's stated target ("ETH"/"BNB"/etc) so the confirm
        // message can say "Swapping 0.1 USDC for ETH". toToken gets re-pointed
        // to fromToken below so receipts/positions are labelled with the
        // source token, but the user wants to see what they're getting.
        swapNativeTarget = toUpper;
        // Re-point toToken so downstream code labels the receipt and position
        // with the SOURCE token (the one being sold), not the native it's
        // being exchanged for. Without this, the position tracks USDC's
        // address but is labelled "ETH", which prints e.g. "ETH on Sepolia"
        // for what was actually a USDC sell.
        toToken = fromToken;
        hlog.agent(
          "gateway",
          `swap: "${fromToken} → ${swapNativeTarget}" treated as SELL ${fromToken} for native`,
        );
      } else {
        // "swap USDC to PEPE" = token-to-token: resolve both, route through Uniswap
        const fromAddr = await resolveSwapSource(fromToken, chainHint, userId);
        if (fromAddr) {
          fromTokenAddress = fromAddr.address;
          resolvedChainName = fromAddr.chain;
          chain = fromAddr.chain === "solana" ? "solana" : "evm";
        }
        // toToken (target) will be resolved below via the normal address resolution path
        sideHint = "buy";
        hlog.agent(
          "gateway",
          `swap: "${fromToken} → ${toToken}" token-to-token, fromAddr=${fromTokenAddress?.slice(0, 10) ?? "?"}`,
        );
      }
    } else if (sideHint === "swap") {
      sideHint = "buy";
    }

    // For sells: check open positions first so "sell $SHIB" finds the position's
    // address and chain instead of resolving fresh via DexScreener (which might
    // pick a different chain, e.g. Solana SHIB instead of Base SHIB the user holds)
    if (sideHint === "sell" && !address && (fromToken || toToken)) {
      const sym = (toToken ?? fromToken)!.toUpperCase();
      const positions = getPositionsByUser(userId);
      if (positions.length > 0) {
        // Match by stored symbol on position
        const symbolMatch = positions.find((p) => p.symbol?.toUpperCase() === sym);
        if (symbolMatch) {
          address = symbolMatch.address;
          resolvedChainName = symbolMatch.chainId;
          chain = symbolMatch.chainId === "solana" ? "solana" : "evm";
          hlog.agent(
            "gateway",
            `sell: matched position ${symbolMatch.positionId.slice(0, 8)} by symbol ${sym} on ${symbolMatch.chainId}`,
          );
        }
        // Fallback: check conversation context
        if (!address) {
          const last = lastResearchByUser.get(userId);
          if (last && last.symbol.toUpperCase() === sym) {
            const posMatch = positions.find(
              (p) => p.address.toLowerCase() === last.address.toLowerCase(),
            );
            if (posMatch) {
              address = posMatch.address;
              resolvedChainName = posMatch.chainId;
              chain = posMatch.chainId === "solana" ? "solana" : "evm";
              hlog.agent(
                "gateway",
                `sell: matched position ${posMatch.positionId.slice(0, 8)} via research context (${sym} on ${posMatch.chainId})`,
              );
            }
          }
        }
        // If only one position, and no address resolved yet, use it
        if (!address && positions.length === 1) {
          const only = positions[0]!;
          address = only.address;
          resolvedChainName = only.chainId;
          chain = only.chainId === "solana" ? "solana" : "evm";
          hlog.agent(
            "gateway",
            `sell: only one position, using ${only.positionId.slice(0, 8)} (${only.chainId})`,
          );
        }
      }
    }

    if (!address && (fromToken || toToken)) {
      const targetSymbol = toToken ?? fromToken;
      if (targetSymbol) {
        const resolveHint =
          chainHint && chainHint !== "evm" && chainHint !== "solana" ? chainHint : undefined;
        const resolved = await resolveToken(targetSymbol, resolveHint);
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

    // Fallback: if no token specified, use the last researched token (within 10 min)
    if (!address) {
      const last = lastResearchByUser.get(userId);
      if (last && Date.now() - last.at < 10 * 60 * 1_000) {
        address = last.address;
        chain = last.chain;
        hlog.agent(
          "gateway",
          `context: last researched ${last.symbol} (${last.address.slice(0, 10)}...)`,
        );
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

    // Known-token lookup: detect testnet tokens by address before DexScreener.
    // DexScreener does not index testnet tokens, so this is the only way to
    // auto-detect sepolia USDC, WETH, etc. without the user saying "sepolia".
    let verifiedTokenName: string | null = null;
    let verifiedTokenSymbol: string | null = null;
    let knownTokenMatch = false;

    if (address && !resolvedChainName) {
      const known = lookupKnownAddress(address);
      if (known) {
        resolvedChainName = known.chain;
        chain = known.chain === "solana" ? "solana" : "evm";
        verifiedTokenSymbol = known.symbol;
        toToken = known.symbol;
        knownTokenMatch = true;
        hlog.agent("gateway", `known token: ${known.symbol} on ${known.chain} (address match)`);
      }
    }

    // DexScreener verification: verify token identity and chain from on-chain data.
    // Skip for known tokens (testnet tokens aren't on DexScreener).
    if (address && !knownTokenMatch) {
      try {
        const { pairs } = await searchPairs(address, { limit: 5 });
        let candidates = pairs
          .filter((p) => p.baseToken?.address?.toLowerCase() === address!.toLowerCase())
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        // If we already know the chain, prefer pairs on that chain
        if (resolvedChainName && candidates.length > 0) {
          const onChain = candidates.filter(
            (p) => (resolveChainAlias(p.chainId) ?? p.chainId) === resolvedChainName,
          );
          if (onChain.length > 0) candidates = onChain;
        }
        const best = candidates[0];
        if (best) {
          verifiedTokenName = best.baseToken?.name ?? null;
          verifiedTokenSymbol = best.baseToken?.symbol ?? null;
          // Only update chain if we didn't already have one
          if (!resolvedChainName) {
            resolvedChainName = resolveChainAlias(best.chainId) ?? best.chainId;
            chain = best.chainId === "solana" ? "solana" : "evm";
          }
          if (toToken && verifiedTokenSymbol && !swapFromTokenAmount) toToken = verifiedTokenSymbol;
          hlog.agent(
            "gateway",
            `DexScreener verified: ${verifiedTokenSymbol} (${verifiedTokenName}) on ${resolvedChainName}`,
          );
        }
      } catch {
        /* DexScreener lookup failed, proceed with LLM data */
      }
    }

    const amountRaw = d["amount"] as Record<string, unknown> | null | undefined;
    let amount: TradeAmount = { value: 0, unit: "NATIVE" };
    if (amountRaw && typeof amountRaw === "object") {
      const v = typeof amountRaw["value"] === "number" ? amountRaw["value"] : 0;
      const u = amountRaw["unit"];
      const unit: TradeAmount["unit"] =
        u === "USD" || u === "TOKEN" || u === "NATIVE" ? u : "NATIVE";
      amount = { value: Number.isFinite(v) && v > 0 ? v : 0, unit };
    }

    // USD override: if raw text has $ near the amount, treat as USD regardless of LLM unit
    const raw = result.rawText;
    const usdMatch = raw.match(/\$\s*([\d.]+)|(\d+(?:\.\d+)?)\s*\$/);
    if (usdMatch && amount.unit === "NATIVE") {
      const val = parseFloat(usdMatch[1] ?? usdMatch[2] ?? "0");
      if (val > 0) amount = { value: val, unit: "USD" };
    }
    // Stablecoin amount: "buy $5 USDC of PEPE" = $5, but "swap 0.1 USDC to ETH" = 0.1 tokens
    // Only convert to USD when the stablecoin is NOT the token being traded
    if ((amount.unit === "NATIVE" || amount.unit === "TOKEN") && amount.value > 0) {
      const stableMatch = raw.match(/([\d.]+)\s*(usdc|usdt|dai|busd)\b/i);
      if (stableMatch) {
        const matchedStable = stableMatch[2]!.toUpperCase();
        const tradingThisStable =
          fromToken?.toUpperCase() === matchedStable || toToken?.toUpperCase() === matchedStable;
        if (!tradingThisStable) {
          const val = parseFloat(stableMatch[1]!);
          if (val > 0 && Math.abs(val - amount.value) < 0.001) {
            amount = { value: val, unit: "USD" };
          }
        }
      }
    }

    // Fallback: parse amount from raw text when LLM doesn't extract it
    if (amount.value <= 0) {
      const ethMatch = raw.match(/([\d.]+)\s*(?:\w+\s+)?(?:ETH|eth|ether)/i);
      if (usdMatch) {
        const val = parseFloat(usdMatch[1] ?? usdMatch[2] ?? "0");
        if (val > 0) amount = { value: val, unit: "USD" };
      } else if (ethMatch) {
        const val = parseFloat(ethMatch[1] ?? "0");
        if (val > 0) amount = { value: val, unit: "NATIVE" };
      } else {
        const numMatch = raw.match(/([\d.]+)\s*(?:of|worth)/i);
        if (numMatch) {
          const val = parseFloat(numMatch[1] ?? "0");
          if (val > 0) amount = { value: val, unit: "NATIVE" };
        }
      }
    }

    // "swap 0.1 USDC to ETH" — amount is in source token, not ETH.
    // Override even if the $ regex fired: "$0.1 USDC" = 0.1 USDC tokens, not $0.10 USD.
    if (swapFromTokenAmount && amount.value > 0) {
      amount = { value: amount.value, unit: "TOKEN" };
    }

    let originalUsdAmount: number | null = null;
    const specificChainEarly = resolvedChainName ?? chainHint ?? null;
    const TESTNET_SET = new Set([
      "sepolia",
      "goerli",
      "mumbai",
      "fuji",
      "base-sepolia",
      "basesepolia",
    ]);
    const isTestnetTrade = specificChainEarly ? TESTNET_SET.has(specificChainEarly) : false;

    // Convert USD amounts to approximate native token amount — for BUYS only.
    // Sells keep `unit: "USD"` so the execution agent can size off live token
    // price + on-chain balance, not pre-converted ETH equivalents.
    // Testnet ETH has no real-world price — ask user to specify in ETH directly
    if (amount.unit === "USD" && amount.value > 0 && sideHint !== "sell") {
      if (isTestnetTrade) {
        const sym = verifiedTokenSymbol ?? toToken ?? "this token";
        void reply(
          rctx,
          `Testnet tokens have no real-world price, so dollar amounts don't apply.\n` +
            `Specify the amount in ETH instead.\n` +
            `Example: "buy 0.01 ETH of ${html(sym)} on ${specificChainEarly}"`,
        );
        lastResearchByUser.set(userId, {
          address: address!,
          chain: chain!,
          ...((resolvedChainName ?? chainHint)
            ? { specificChain: (resolvedChainName ?? chainHint)! }
            : {}),
          symbol: toToken ?? address!.slice(0, 10),
          at: Date.now(),
        });
        return;
      }
      originalUsdAmount = amount.value;
      const ethPriceUsd = await fetchEthPrice().catch(() => 2500);
      const ethEquiv = amount.value / ethPriceUsd;
      hlog.agent(
        "gateway",
        `$${amount.value} → ${ethEquiv.toFixed(8)} ETH (price=$${ethPriceUsd})`,
      );
      amount = { value: ethEquiv, unit: "NATIVE" };
    }

    // Apply user's default amount when none specified — BUYS only.
    // For sells, missing amount means "ask the user how much" rather than
    // defaulting to a NATIVE buy-size.
    if (amount.value <= 0 && sideHint !== "sell") {
      const defAmt = userSettings.get(userId)?.defaultAmount;
      if (defAmt && defAmt > 0) {
        amount = { value: defAmt, unit: "NATIVE" };
      }
    }

    const side: "buy" | "sell" =
      sideHint === "sell" ? "sell" : d["side"] === "sell" ? "sell" : "buy";

    if (amount.value <= 0) {
      const sym =
        verifiedTokenSymbol ?? toToken ?? (address ? address.slice(0, 10) + "..." : "this token");
      const chainLabel = specificChainEarly ?? "evm";
      if (side === "sell") {
        void reply(
          rctx,
          `How much do you want to sell of ${html(sym)}?\n` +
            (isTestnetTrade
              ? `Example: "sell 0.005 ETH of ${html(sym)}"`
              : `Example: "sell $5 worth" or "sell 50% of ${html(sym)}"`),
        );
      } else {
        void reply(
          rctx,
          `How much do you want to buy of ${html(sym)} on ${html(chainLabel)}?\n` +
            (isTestnetTrade
              ? `Example: "buy 0.01 ETH of ${html(sym)} on ${html(chainLabel)}"`
              : `Example: "buy $5 worth" or "buy 0.01 ETH of ${html(sym)}"`),
        );
      }
      lastResearchByUser.set(userId, {
        address: address!,
        chain: chain!,
        ...((resolvedChainName ?? chainHint)
          ? { specificChain: (resolvedChainName ?? chainHint)! }
          : {}),
        symbol: toToken ?? address!.slice(0, 10),
        at: Date.now(),
      });
      return;
    }

    const urgencyRaw = d["urgency"];
    const userMode = userSettings.get(userId)?.mode;
    const urgency: TradingMode =
      urgencyRaw === "INSTANT" || urgencyRaw === "CAREFUL" ? urgencyRaw : (userMode ?? "NORMAL");

    const specificChain = resolvedChainName ?? chainHint ?? null;

    const defaultExits: TradeIntent["exits"] =
      side === "buy"
        ? [
            { target: { kind: "multiplier", value: 2.0 }, percent: 50 },
            { target: { kind: "multiplier", value: 5.0 }, percent: 100 },
          ]
        : [];

    const tokenSymbol = verifiedTokenSymbol ?? toToken ?? undefined;
    const intentBase = {
      intentId: result.id,
      userId: result.userId,
      channel: result.channel,
      address,
      chain,
      amount,
      exits: defaultExits,
      urgency,
      rawText: result.rawText,
      createdAt: result.routedAt,
      side,
      ...(tokenSymbol ? { symbol: tokenSymbol } : {}),
      ...(fromToken ? { fromToken } : {}),
      ...(fromTokenAddress ? { fromTokenAddress } : {}),
    };
    const intent: TradeIntent = specificChain
      ? { ...intentBase, chainHint: specificChain as ChainId }
      : intentBase;

    const isTestnet = specificChain
      ? ["sepolia", "goerli", "mumbai", "fuji", "base-sepolia"].includes(specificChain)
      : false;
    const walletAddr = walletMgr?.getWallet(userId)?.address ?? undefined;
    const pending: PendingReply = { ctx: rctx, rootHash: null };
    if (isTestnet) pending.isTestnet = true;
    if (walletAddr) pending.walletAddress = walletAddr;
    if (specificChain) pending.chainHint = specificChain;
    else if (chain === "evm") pending.chainHint = "ethereum";
    if (amount.value > 0) pending.tradeAmount = amount.value;
    if (side === "sell") pending.isSell = true;
    pendingMap.set(intent.intentId, pending);

    // Upfront balance check for sells: verify user holds the token before pipeline
    if (side === "sell" && walletAddr && specificChain) {
      try {
        const { balance } = await fetchTokenBalance(specificChain, address, walletAddr, 4_000);
        if (balance === 0n) {
          pendingMap.delete(intent.intentId);
          const sym = verifiedTokenSymbol ?? toToken ?? address.slice(0, 10);
          void reply(
            rctx,
            `You don't hold any ${html(sym)} on ${html(getChainName(specificChain))}. Check /balance to see what you have.`,
          );
          return;
        }
      } catch {
        // RPC failed — let execution agent handle it
      }
    }

    trackToken(
      userId,
      address,
      specificChain ?? (chain === "evm" ? "ethereum" : chain),
      tokenSymbol,
    );
    bus.emit("TRADE_REQUEST", intent);

    // Save to conversation context so "buy $2" works after "ape this 0xCA..."
    lastResearchByUser.set(userId, {
      address,
      chain,
      ...((resolvedChainName ?? chainHint)
        ? { specificChain: (resolvedChainName ?? chainHint)! }
        : {}),
      symbol: toToken ?? address.slice(0, 10),
      at: Date.now(),
    });

    const displaySymbol = verifiedTokenSymbol ?? toToken;
    const tokenLabel = displaySymbol
      ? html(displaySymbol.toUpperCase())
      : codeAddr(address.slice(0, 10) + "...");
    const chainLabel = specificChain ? html(getChainName(specificChain)) : chain;
    const amountUnit =
      amount.unit === "PERCENT" && amount.value > 0
        ? `${amount.value}%`
        : amount.unit === "USD" && amount.value > 0
          ? `$${amount.value}`
          : originalUsdAmount != null
            ? `$${originalUsdAmount}`
            : swapFromTokenAmount && fromToken
              ? `${amount.value} ${fromToken.toUpperCase()}`
              : amount.unit === "TOKEN" && fromToken
                ? `${amount.value} ${fromToken.toUpperCase()}`
                : amount.value > 0
                  ? `${amount.value.toFixed(6)} ETH`
                  : "";
    const amountDisplay = amount.value > 0 ? amountUnit : "";
    const isSwap = !!(fromToken && toToken);
    let confirmMsg: string;
    if (isSwap && side === "sell") {
      // "swap USDC to ETH" → "Swapping 0.1 USDC for ETH on Ethereum".
      // swapNativeTarget holds the original target ("ETH") since toToken was
      // re-pointed to fromToken for position labelling; fall back to toToken
      // for safety if that branch wasn't taken.
      const toLabel = html((swapNativeTarget ?? toToken!).toUpperCase());
      confirmMsg = amountDisplay
        ? `Swapping ${amountDisplay} for ${toLabel} on ${chainLabel}...`
        : `Swapping ${html(fromToken!.toUpperCase())} for ${toLabel} on ${chainLabel}...`;
    } else if (isSwap && fromTokenAddress) {
      // "swap USDC to PEPE" → "Swapping 0.1 USDC for PEPE on Ethereum"
      confirmMsg = amountDisplay
        ? `Swapping ${amountDisplay} for ${tokenLabel} on ${chainLabel}...`
        : `Swapping ${html(fromToken!.toUpperCase())} for ${tokenLabel} on ${chainLabel}...`;
    } else {
      const actionVerb = side === "sell" ? "Selling" : "Buying";
      const connector = "of";
      confirmMsg = `${actionVerb}${amountDisplay ? " " + amountDisplay + " " + connector : ""} ${tokenLabel} on ${chainLabel}...`;
    }
    await reply(rctx, confirmMsg);

    if (storage && !storage.circuitOpen) {
      void storage
        .writeJson(intent.intentId, intent)
        .then((res) => {
          pending.rootHash = res.rootHash;
          hlog.og(
            "storage",
            `audit intent=${intent.intentId.slice(0, 8)} root=${res.rootHash.slice(0, 14)}...`,
          );
        })
        .catch((err) => {
          if (!storage.circuitOpen) {
            console.error("[telegram] 0G storage failed:", (err as Error).message);
          }
        });
    }
  }

  function handleResearch(
    result: RouterResult,
    rctx: ReplyCtx,
    pendingMap: Map<string, PendingReply>,
  ): void {
    const d = result.data;
    const address =
      typeof d["address"] === "string"
        ? d["address"]
        : typeof d["walletAddress"] === "string"
          ? d["walletAddress"]
          : null;
    const chain =
      d["chain"] === "evm" || d["chain"] === "solana" ? (d["chain"] as ChainClass) : null;

    const requestId = randomUUID();
    pendingMap.set(requestId, { ctx: rctx, rootHash: null });

    const subIntent = (d["subIntent"] as ResearchSubIntent) ?? "TOKEN_LOOKUP";
    const tools = Array.isArray(d["tools"]) ? (d["tools"] as string[]) : [];

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
      subIntent,
      tools,
    });

    const thinkingMsgs: Record<ResearchSubIntent, string> = {
      TRENDING: "Finding what's hot right now...",
      MARKET_OVERVIEW: "Pulling market data...",
      WHALE_ANALYSIS: "Checking whale activity...",
      SAFETY_CHECK: "Running safety scan...",
      PRICE_ACTION: "Checking price action...",
      CATEGORY: "Browsing tokens in that category...",
      TOKEN_LOOKUP: address
        ? `Looking up ${codeAddr(address)}...`
        : "Looking into that. Paste a contract address for a full breakdown.",
      RESEARCH_WALLET: address
        ? `Looking up wallet ${codeAddr(address)}...`
        : "Looking into that wallet...",
    };
    void reply(rctx, thinkingMsgs[subIntent] ?? "Looking into that...");
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

  async function handlePortfolio(
    result: RouterResult,
    rctx: ReplyCtx,
    walletMgr: WalletManager | null,
    userId: string,
  ): Promise<void> {
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
    const addr = config.activeAddress;
    if (!addr) {
      void reply(rctx, "No active wallet. Use /wallet to set one up.");
      return;
    }

    const chains = ["ethereum", "sepolia", "base", "arbitrum", "optimism", "polygon", "bsc"];

    // Build the extra-tokens list from tracked positions + seen tokens so
    // anything the user has bought through the bot (incl. on Sepolia) gets
    // a balanceOf call even though it's not in the well-known stable list.
    const userPositions = getPositionsByUser(userId);
    const seenTokens = getSeenTokens(userId);
    const extraSet = new Set<string>();
    const extraTokens: Array<{ address: string; chainId: string; symbol?: string | undefined }> =
      [];
    for (const p of userPositions) {
      const key = `${p.chainId}:${p.address.toLowerCase()}`;
      if (!extraSet.has(key)) {
        extraSet.add(key);
        extraTokens.push({ address: p.address, chainId: p.chainId, symbol: p.symbol });
      }
    }
    for (const s of seenTokens) {
      const key = `${s.chainId}:${s.address.toLowerCase()}`;
      if (!extraSet.has(key)) {
        extraSet.add(key);
        extraTokens.push({ address: s.address, chainId: s.chainId, symbol: s.symbol });
      }
    }

    let portfolioUsd = 0;
    const [nativeLines, tokenData] = await Promise.all([
      Promise.all(
        chains.map(async (chain) => {
          const cfg = EVM_CHAIN_CONFIG[chain];
          const currency = cfg?.nativeCurrency ?? "ETH";
          const { balance, error } = await fetchNativeBalance(chain, addr);
          if (error) return null;
          const ethVal = Number(balance) / 1e18;
          if (ethVal > 0.00001) {
            const isTestnet = chain === "sepolia";
            let usdStr = "";
            if (!isTestnet) {
              const price = await fetchNativePrice(currency);
              const usd = ethVal * price;
              portfolioUsd += usd;
              usdStr = usd >= 0.01 ? ` (~$${formatUsd(usd)})` : "";
            }
            return `  ${getChainName(chain)}: ${ethVal.toFixed(6)} ${currency}${usdStr}`;
          }
          return null;
        }),
      ),
      fetchTokenHoldings(addr, chains, 10_000, extraTokens),
    ]);

    const balanceLines = nativeLines.filter((l): l is string => l !== null);

    const tokenLines: string[] = [];
    const heldTokens = tokenData.assets.filter(
      (a) => a.tokenSymbol !== "ETH" && a.tokenSymbol !== "WETH" && parseFloat(a.balance) > 0,
    );
    for (const t of heldTokens.slice(0, 15)) {
      tokenLines.push(`  ${t.tokenSymbol} (${getChainName(t.blockchain)}): ${t.balance}`);
    }

    const positions = userPositions;
    const posLines: string[] = [];
    if (positions.length > 0) {
      posLines.push(``);
      for (const pos of positions) {
        const label = pos.symbol ?? pos.address.slice(0, 8) + "...";
        const priceStr =
          pos.entryPriceUsd >= 1
            ? `$${pos.entryPriceUsd.toFixed(2)}`
            : `$${pos.entryPriceUsd.toFixed(6)}`;
        posLines.push(`${label} on ${getChainName(pos.chainId)}  ${priceStr}`);
      }
    }

    if (balanceLines.length === 0 && tokenLines.length === 0 && positions.length === 0) {
      const solWallet = walletMgr.getSolanaWallet(userId);
      const lines = [
        `<b>Your wallets</b>`,
        ``,
        `EVM  ${codeAddr(addr)}`,
        ...(solWallet ? [`SOL  ${codeAddr(solWallet.address)}`] : []),
        ``,
        `No balances or positions yet. Send ETH to your EVM address to start trading.`,
      ];
      void reply(rctx, lines.join("\n"));
      return;
    }

    const totalLine = portfolioUsd >= 0.01 ? [``, `Total ~$${formatUsd(portfolioUsd)}`] : [];
    const sections = [`<b>Portfolio</b>  ${codeAddr(addr)}`, ``, ...balanceLines];
    if (tokenLines.length > 0) {
      sections.push(``, ...tokenLines);
    }
    sections.push(...totalLine, ...posLines);
    void reply(rctx, sections.join("\n"));
  }

  function handleSettings(result: RouterResult, rctx: ReplyCtx): void {
    const d = result.data;
    const setting = typeof d["setting"] === "string" ? d["setting"].toLowerCase() : "";
    const value = typeof d["value"] === "string" ? d["value"].toLowerCase() : "";

    if (setting.includes("mode") || setting.includes("trading") || value in MODE_MAP) {
      const modeKey = value in MODE_MAP ? value : setting;
      const mode = MODE_MAP[modeKey] ?? MODE_MAP[value];
      if (mode) {
        const ex = userSettings.get(rctx.userId);
        const prevAmt = ex?.defaultAmount;
        const settingsEntry: { mode: TradingMode; defaultAmount?: number } = { mode };
        if (prevAmt !== undefined) settingsEntry.defaultAmount = prevAmt;
        userSettings.set(rctx.userId, settingsEntry);
        const friendlyName = mode === "INSTANT" ? "degen" : mode === "CAREFUL" ? "safe" : "normal";
        void reply(rctx, `Mode: ${friendlyName}. ${MODE_DESC[mode]}`);
        return;
      }
    }

    void llmReply(
      rctx,
      result.rawText,
      `The user wants to change a setting. Available settings: trading mode (degen/normal/safe) via /mode. Acknowledge and guide them.`,
      `Available settings:\n  /mode degen — auto-execute\n  /mode normal — confirm risky\n  /mode safe — strict safety`,
    );
  }

  function handleCopyTrade(result: RouterResult, rctx: ReplyCtx): void {
    const d = result.data;
    const address = typeof d["walletAddress"] === "string" ? d["walletAddress"] : null;

    if (address && /^0x[a-fA-F0-9]{40}$/.test(address)) {
      bus.emit("ADD_WATCHED_WALLET", { address, chain: "evm" });
      void reply(
        rctx,
        `Now watching ${codeAddr(address)} for copy trading.\nI'll copy their buys automatically through the safety pipeline.`,
      );
      return;
    }

    void llmReply(
      rctx,
      result.rawText,
      `The user wants to copy trade. They need to provide a wallet address. Tell them to use /watch 0xABC... [label] to start copy trading a wallet. Mention they can use /watchlist to see watched wallets.`,
      `To start copy trading, use:\n  /watch 0xABC... [label]\n\nI'll automatically copy their buys through the safety pipeline. Use /watchlist to see your watched wallets.`,
    );
  }

  async function handleConversational(
    result: RouterResult,
    rctx: ReplyCtx,
    llmClient: FallbackLlmClient | null,
  ): Promise<void> {
    const hasWallet = wm ? wm.getWallet(rctx.userId) != null : false;
    const positions = getPositionsByUser(rctx.userId);

    if (!llmClient) {
      void reply(rctx, smartFallback(result.rawText, hasWallet, positions.length));
      return;
    }

    try {
      const history = recentHistory(rctx.userId);
      const userContext = hasWallet
        ? `\nUser has a wallet set up. ${positions.length} open positions.`
        : "\nNew user, no wallet yet.";
      const resp = await llmClient.infer({
        system:
          CONVERSATIONAL_PROMPT +
          composeSkillsPrompt("gateway", getUserSkillOverrides(rctx.userId)) +
          userContext +
          history,
        user: result.rawText,
        temperature: 0.7,
        maxTokens: 300,
      });
      void reply(rctx, html(resp.text), "HTML");
    } catch (err) {
      console.warn("[telegram] conversational LLM failed:", (err as Error).message);
      void reply(rctx, smartFallback(result.rawText, hasWallet, positions.length));
    }
  }

  function smartFallback(text: string, hasWallet: boolean, posCount: number): string {
    const lower = text.toLowerCase().trim();
    const isGreeting = /^(hi|hey|hello|yo|sup|gm|good\s*(morning|evening|afternoon))[\s!.]*$/i.test(
      lower,
    );

    if (isGreeting && hasWallet) {
      return posCount > 0
        ? `Hey! You have ${posCount} open position${posCount > 1 ? "s" : ""}. Paste a contract address to trade, or ask "what's trending?" to scan for alpha.`
        : "Hey! Your wallet is ready. Paste a contract address to trade, or ask me what's trending.";
    }
    if (isGreeting) {
      return "Hey! I'm HAWKEYE, your on-chain trading agent. Say /wallet to get started, or paste a contract address to trade.";
    }
    if (hasWallet) {
      return "I can help with that. Try pasting a contract address, asking about a token, or say /help for all commands.";
    }
    return "I'm HAWKEYE. Set up your wallet with /wallet first, or paste a contract address to research a token.";
  }

  await bot.init();
  hlog.boot(`bot @${bot.botInfo.username} starting...`);

  // Register the slash-command menu so typing `/` in Telegram suggests
  // every command. Telegram caches this server-side; the call is
  // idempotent and non-critical, so failures only warn.
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Welcome and quick start" },
      { command: "wallet", description: "Create or view your wallet" },
      { command: "balance", description: "Balances across chains" },
      { command: "positions", description: "Open trades and PnL" },
      { command: "history", description: "Recent trade history" },
      { command: "send", description: "Transfer native tokens" },
      { command: "mode", description: "Trading mode: degen, normal, safe" },
      { command: "skills", description: "Toggle agent behavior skills" },
      { command: "llm", description: "LLM routing status (0G vs fallback)" },
      { command: "watch", description: "Copy a wallet's buys" },
      { command: "unwatch", description: "Stop copying a wallet" },
      { command: "watchlist", description: "Show watched wallets" },
      { command: "link", description: "Add email recovery to wallet" },
      { command: "status", description: "System health and agent status" },
      { command: "help", description: "Full command guide" },
    ]);
  } catch (err) {
    hlog.warn(`setMyCommands failed: ${(err as Error).message}`);
  }

  bot.start({
    onStart: () => hlog.boot(`bot @${bot.botInfo.username} is live`),
  });

  return {
    bot,
    stop: () => {
      bus.off("TRADE_EXECUTED", onTradeExecutedForTracking);
      bus.off("TRADE_EXECUTED", onExecuted);
      bus.off("STRATEGY_DECISION", onStrategy);
      bus.off("SAFETY_RESULT", onSafety);
      bus.off("RESEARCH_RESULT", onResearchResult);
      bus.off("QUOTE_FAILED", onQuoteFailed);
      bus.off("POSITION_UPDATE", onPositionUpdate);
      bus.off("WALLET_FUNDED", onWalletFunded);
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
    hlog.og("storage", "gateway audit writer ready");
    return client;
  } catch (err) {
    hlog.warn(`gateway 0G Storage: ${(err as Error).message}`);
    return null;
  }
}
