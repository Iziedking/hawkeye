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
} from "../shared/types";
import { loadEnvLocal, envOr } from "../shared/env";
import { resolveToken, resolveChainAlias, lookupKnownAddress } from "../shared/tokens";
import { formatHealthForTelegram, getHealth } from "../shared/health";
import { getChainRpc, getChainExplorer, getChainName, EVM_CHAIN_CONFIG, fetchNativeBalance, fetchTokenHoldings } from "../shared/evm-chains";
import { CONVERSATION_MAX_MESSAGES, CONVERSATION_TTL_MS } from "../shared/constants";
import { getPositionsByUser } from "../agents/execution/index";
import { getWatchedWalletAddresses } from "../agents/copy-trade/index";
import { searchPairs } from "../tools/dexscreener-mcp/client";
import { loadSeenTokens, trackToken, getSeenTokens } from "../shared/seen-tokens";

loadEnvLocal();
loadSeenTokens();

type ReplyCtx = { chatId: number; userId: string };

type PendingReply = {
  ctx: ReplyCtx;
  rootHash: string | null;
  isTestnet?: boolean;
  walletAddress?: string;
  chainHint?: string;
  tradeAmount?: number;
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
  } catch { /* use cached */ }
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
    const msgLines = [
      "<b>Trade Executed</b>",
      ...(pos.symbol ? [`Token: ${pos.symbol}`] : []),
      `Filled: ${pos.filled.value} ${pos.filled.unit}`,
      `Entry: $${pos.entryPriceUsd.toFixed(6)}`,
      `Chain: ${html(chainName)}`,
      `TX: ${codeAddr(pos.txHash)}`,
      `<a href="${explorer}/tx/${pos.txHash}">View on Explorer</a>`,
    ];
    if (pos.mevProtected) {
      msgLines.push(`MEV Protection: KeeperHub`);
    }
    if (pending.rootHash) {
      msgLines.push(`Verified on 0G: ${codeAddr(pending.rootHash)}`);
    }
    void reply(pending.ctx, msgLines.join("\n"));
  };

  type PendingConfirmation = { ctx: ReplyCtx; intentId: string; messageId?: number; timer: ReturnType<typeof setTimeout> };
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
        void reply(pending.ctx, `Trade rejected: ${html(d.reason)}`);
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
        void bot.api.editMessageText(
          pc.ctx.chatId,
          pc.messageId,
          `Confirmation expired for this trade.`,
        ).catch(() => {});
      }
    }, 60_000);

    const pc: PendingConfirmation = { ctx: pending.ctx, intentId: d.intentId, timer };
    pendingConfirmations.set(d.intentId, pc);

    void bot.api
      .sendMessage(pending.ctx.chatId, `<b>Confirm trade?</b>\n${html(d.reason)}`, {
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
    if (r.score >= 70 && r.flags.length === 0) return;
    if (r.flags.length > 0) {
      const flagText = r.flags.join(", ");
      void reply(pending.ctx, `Safety warning: <b>${r.score}/100</b> — ${html(flagText)}`);
    }
  };

  // Cache address→chain from trending results so research callbacks know which chain to query
  const trendingChainCache = new Map<string, string>();

  // Per-user last researched token — so "buy $2" uses the token from conversation context
  type LastResearch = { address: string; chain: ChainClass; specificChain?: string; symbol: string; at: number };
  const lastResearchByUser = new Map<string, LastResearch>();

  // Per-user pending buy from inline keyboard — holds full context until user provides amount
  type PendingBuy = { address: string; chain: ChainClass; specificChain: string; symbol: string; at: number };
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
    const hasName = (res.symbol && !res.symbol.startsWith("0x")) || (res.tokenName && !res.tokenName.startsWith("0x"));
    const label = hasName ? (res.symbol ?? res.tokenName ?? res.address.slice(0, 10)) : res.address.slice(0, 10);
    if (hasName) {
      lines.push(`<b>${html(res.symbol ?? "")}${res.tokenName && !res.tokenName.startsWith("0x") ? ` (${html(res.tokenName)})` : ""}</b>`);
    } else {
      lines.push(`<b>Token</b> ${codeAddr(res.address)}`);
    }
    if (res.safetyScore !== null) {
      const tag = res.safetyScore >= 70 ? "OK" : res.safetyScore >= 40 ? "CAUTION" : "DANGER";
      lines.push(`Safety: <b>${res.safetyScore}/100</b> [${tag}]`);
    }
    if (res.flags.length > 0) {
      lines.push(`Flags: ${res.flags.join(", ")}`);
    }
    const stats: string[] = [];
    if (res.priceUsd != null) stats.push(`Price: $${formatUsd(res.priceUsd)}`);
    if (res.liquidityUsd != null) stats.push(`Liq: $${formatUsd(res.liquidityUsd)}`);
    if (stats.length) lines.push(stats.join(" | "));
    const stats2: string[] = [];
    if (res.priceChange24h != null) {
      const sign = res.priceChange24h >= 0 ? "+" : "";
      stats2.push(`24h: ${sign}${res.priceChange24h.toFixed(1)}%`);
    }
    if (res.volume24h != null) stats2.push(`Vol: $${formatUsd(res.volume24h)}`);
    if (res.fdv != null && res.fdv > 0) stats2.push(`FDV: $${formatUsd(res.fdv)}`);
    if (stats2.length) lines.push(stats2.join(" | "));
    if (res.opportunityScore != null) {
      lines.push(`Opportunity: <b>${res.opportunityScore}/100</b>`);
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

    if (/insufficient funds|exceeds the balance/i.test(qf.reason) && pending.walletAddress && pending.chainHint) {
      void (async () => {
        try {
          const { balance } = await fetchNativeBalance(pending.chainHint!, pending.walletAddress!);
          const ethBal = Number(balance) / 1e18;
          const ethPrice = await fetchEthPrice().catch(() => 2500);
          const usdBal = ethBal * ethPrice;
          const chainName = getChainName(pending.chainHint!);
          const needed = pending.tradeAmount ? ` You need ~${pending.tradeAmount.toFixed(6)} ETH.` : "";
          void reply(pending.ctx,
            `Insufficient funds on ${html(chainName)}.\n` +
            `Balance: ${ethBal.toFixed(6)} ETH (~$${usdBal.toFixed(2)}).${needed}\n` +
            `Use /wallet to check all balances.`,
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
      userMsg = "No trading pairs found on any DEX. The token may be too new, unlisted, or on an unsupported chain.";
    } else if (/execution reverted|transaction_broadcast_failure/i.test(qf.reason)) {
      userMsg = "Transaction reverted. Your wallet may not hold this token or may not have enough ETH for gas. Use /wallet to check.";
    } else if (/fetch failed/i.test(qf.reason)) {
      userMsg = "Network error reaching the swap API. Try again in a moment.";
    }

    void reply(pending.ctx, html(userMsg.slice(0, 300)));
  };

  const positionOwners = new Map<string, ReplyCtx>();
  const lastPnlNotify = new Map<string, number>();

  const onTradeExecutedForTracking = (pos: import("../shared/types").TradeExecutedPayload): void => {
    const pending = replyByRequestId.get(pos.intentId);
    if (pending) positionOwners.set(pos.positionId, pending.ctx);
  };

  const lastPnlValue = new Map<string, number>();
  const POSITION_NOTIFY_INTERVAL_MS = 3_600_000; // 1 hour
  const SIGNIFICANT_PNL_CHANGE_PCT = 5; // alert on 5%+ PnL shift since last notification

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
    const alertTag = isSignificant && !isScheduled
      ? (update.pnlPct > prevPnl ? " [Price Up]" : " [Price Down]")
      : "";
    void reply(
      owner,
      `Position ${update.positionId.slice(0, 8)}... | $${update.priceUsd.toFixed(6)} | PnL: ${sign}${update.pnlPct.toFixed(1)}%${alertTag}`,
    );
    lastPnlNotify.set(update.positionId, Date.now());
    lastPnlValue.set(update.positionId, update.pnlPct);
  };

  bus.on("TRADE_EXECUTED", onTradeExecutedForTracking);
  bus.on("TRADE_EXECUTED", onExecuted);
  bus.on("STRATEGY_DECISION", onStrategy);
  bus.on("SAFETY_RESULT", onSafety);
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
      ].filter(Boolean).join(" ");

      try {
        const resp = await llm.infer({
          system: CONVERSATIONAL_PROMPT + "\n\nContext: " + context,
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
        "<b>HAWKEYE</b> — Autonomous On-Chain Agent\n",
        "I can help you trade, research tokens, track portfolios, copy wallets, and find alpha across chains.\n",
        "Quick start:",
        "  /wallet — Create your agent wallet",
        "  /balance — Check balances across chains",
        "  Paste a contract address to trade\n",
        "Use /help for the full command guide.",
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
        "/wallet — Create or view your wallet (email sign-in)",
        "/link — Tie your wallet to an email",
        "/balance — Check wallet balances across chains",
        "/positions — View open positions and PnL",
        "/send — Send native tokens to a wallet",
        "/mode — Switch trading mode (degen/normal/safe)",
        "/watch — Add wallet to copy-trade watch list",
        "/unwatch — Remove wallet from watch list",
        "/watchlist — Show watched wallets",
        "/status — System health and uptime\n",
        "<b>Wallet</b>",
        "<code>connect 0x... [label]</code> — Link external wallet",
        "<code>disconnect 0x...</code> — Remove linked wallet",
        "<code>use 0x...</code> — Set active wallet for trades",
        "<code>use agent wallet</code> — Switch to HAWKEYE wallet\n",
        "<b>Trading</b>",
        "Paste a contract address to snipe",
        '"Swap 0.1 ETH to USDC on Base"',
        "<code>/mode degen</code> — Auto-execute trades",
        "<code>/mode safe</code> — Strict safety checks",
        "<code>/mode amount 0.01</code> — Set default buy amount\n",
        "<b>Copy Trading</b>",
        "<code>/watch 0xABC... whale1</code> — Copy a wallet's buys",
        "<code>/unwatch 0xABC...</code> — Stop copying\n",
        "<b>Research</b>",
        '"Is 0x... safe?"',
        '"Check this token"',
        '"What\'s trending?"',
      ].join("\n"),
      { parse_mode: "HTML" },
    );
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
    const extraTokens: Array<{ address: string; chainId: string; symbol?: string | undefined }> = [];
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

    // Fetch native balances and token holdings in parallel
    const nonTestnetChains = chains.filter((c) => c !== "sepolia");
    const [nativeResults, tokenData] = await Promise.all([
      Promise.all(chains.map(async (chain) => {
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
      })),
      fetchTokenHoldings(addr, nonTestnetChains, 10_000, extraTokens),
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

    const lines = [
      `<b>Balances</b>`,
      `Wallet: ${codeAddr(addr)} (${config.mode})`,
      ``,
      `<b>Native</b>`,
      ...balanceLines,
    ];

    if (tokenLines.length > 0) {
      lines.push(``, `<b>Tokens</b>`);
      lines.push(...tokenLines);
    }

    if (totalUsd >= 0.01) {
      lines.push(``, `<b>Total: ~$${formatUsd(totalUsd)}</b>`);
    }
    if (!hasNativeBalance && tokenLines.length === 0) {
      lines.push(``, `No funds detected. Send some ETH/tokens to your wallet address to start trading.`);
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
    if (emailArg && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg) && !emailArg.endsWith("@hawkeye.local")) {
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
      await ctx.reply(
        [
          "Enter your email to create your HAWKEYE wallet.",
          "",
          "This email ties your wallet to your identity across Telegram, Discord, and web.",
          "Your wallet is secured by Privy. EVM trades are routed through KeeperHub for MEV protection.",
        ].join("\n"),
      );
      return;
    }

    const full = wm.getFullWalletConfig(userId);
    if (!full) {
      await ctx.reply("No wallet profile found. Use /wallet to create one.");
      return;
    }

    const khOk = getHealth().subsystems.some((s) => s.name === "KeeperHub" && s.ok);

    const lines: string[] = ["<b>Your Wallets</b>\n"];
    const isSynthetic = full.email.endsWith("@hawkeye.local");
    lines.push(`Email: ${isSynthetic ? "<i>not linked</i> (/link to add)" : `<b>${full.email}</b>`}`);
    lines.push(`Execution: <b>${khOk ? "KeeperHub (MEV protected)" : "Direct"}</b>`);
    lines.push("");
    const isAgentActive = full.activeWallet.kind === "agent";

    if (full.agentWallet) {
      const tag = isAgentActive ? " [ACTIVE]" : "";
      lines.push(`EVM: ${codeAddr(full.agentWallet.address)}${tag}`);
    }
    const solWallet = wm.getSolanaWallet(userId);
    if (solWallet) {
      lines.push(`Solana: ${codeAddr(solWallet.address)}`);
    } else if (full.agentWallet) {
      void wm.ensureSolanaWallet(userId).then((sw) => {
        if (sw) {
          void ctx.reply(`Solana wallet added: ${codeAddr(sw.address)}`, { parse_mode: "HTML" });
        }
      }).catch(() => {});
    }

    if (full.externalWallets.length > 0) {
      lines.push("");
      lines.push("<b>Connected Wallets</b>");
      for (const ew of full.externalWallets) {
        const isActive =
          full.activeWallet.kind === "external" &&
          full.activeWallet.address.toLowerCase() === ew.address.toLowerCase();
        const tag = isActive ? " [ACTIVE]" : "";
        const delegation = ew.delegated ? "" : " (view-only)";
        lines.push(`${ew.label}: ${codeAddr(ew.address)}${tag}${delegation}`);
      }
    }

    lines.push("");
    lines.push(`Active for trades: <b>${full.activeAddress ? codeAddr(full.activeAddress) : "none"}</b>`);
    lines.push("");
    lines.push("<b>Commands</b>");
    lines.push("<code>connect 0x... [label]</code> — Link wallet");
    lines.push("<code>disconnect 0x...</code> — Remove wallet");
    lines.push("<code>use 0x...</code> — Set active wallet");
    lines.push("<code>use agent wallet</code> — Switch to agent wallet");

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
        "Usage: <code>/send &lt;amount&gt; &lt;recipient&gt; [chain]</code>\nExample: <code>/send 0.01 0xABC... base</code>",
      );
      return;
    }

    const amount = Number(args[0]);
    if (!Number.isFinite(amount) || amount <= 0) {
      await reply(rctx, `Invalid amount: ${html(args[0] ?? "")}`);
      return;
    }
    const recipient = args[1]!;
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      await reply(rctx, "Invalid recipient address. Must be a 0x address (40 hex chars).");
      return;
    }

    const chainInput = args[2] ?? "ethereum";
    const chain = resolveChainNumeric(chainInput);
    if (!chain) {
      await reply(
        rctx,
        `Unknown chain: ${html(chainInput)}. Try: ethereum, base, arb, op, polygon, bsc, sepolia`,
      );
      return;
    }

    await executeSend(rctx, userId, recipient, amount, chain.name, chain.id);
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
    INSTANT: "Auto-execute trades. Warnings shown but won't block.",
    NORMAL: "Confirm risky trades (safety 50-69). Reject below 50.",
    CAREFUL: "Reject anything below 70. Confirm if any flags present.",
  };

  // /mode — switch trading mode
  bot.command("mode", async (ctx) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const arg = (ctx.match as string).trim().toLowerCase();

    if (!arg) {
      const current = userSettings.get(userId)?.mode ?? "NORMAL";
      const friendlyName = current === "INSTANT" ? "degen" : current === "CAREFUL" ? "safe" : "normal";
      const defAmt = userSettings.get(userId)?.defaultAmount;
      await ctx.reply(
        [
          `<b>Trading Mode: ${friendlyName}</b>`,
          MODE_DESC[current],
          defAmt ? `Default buy amount: ${defAmt} ETH` : `No default buy amount set.`,
          ``,
          `Change with:`,
          `  <code>/mode degen</code> — auto-execute`,
          `  <code>/mode normal</code> — confirm risky`,
          `  <code>/mode safe</code> — strict safety`,
          `  <code>/mode amount 0.01</code> — set default buy amount`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    // /mode amount 0.01 — set default buy amount
    const amountMatch = arg.match(/^amount\s+([\d.]+)$/);
    if (amountMatch) {
      const val = parseFloat(amountMatch[1]!);
      if (!Number.isFinite(val) || val <= 0) {
        await ctx.reply("Invalid amount. Example: <code>/mode amount 0.01</code>", { parse_mode: "HTML" });
        return;
      }
      const existing = userSettings.get(userId);
      userSettings.set(userId, { mode: existing?.mode ?? "NORMAL", defaultAmount: val });
      await ctx.reply(
        `<b>Default buy amount set: ${val} ETH</b>\nThis will be used when you tap Buy from a research card.`,
        { parse_mode: "HTML" },
      );
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
    await ctx.reply(
      `<b>Mode set: ${friendlyName}</b>\n${MODE_DESC[mode]}`,
      { parse_mode: "HTML" },
    );
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
    const lines = ["<b>Open Positions</b>\n"];
    for (const pos of positions) {
      const label = pos.symbol ? `${pos.symbol} ` : "";
      const chain = getChainName(pos.chainId);
      const age = Math.round((Date.now() - pos.openedAt) / 60_000);
      const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      lines.push(
        `${label}${codeAddr(pos.address.slice(0, 10))}...`,
        `  Chain: ${chain} | Entry: $${pos.entryPriceUsd.toFixed(6)}`,
        `  Amount: ${pos.filled.value} ${pos.filled.unit} | ${ageStr}`,
        `  TX: ${codeAddr(pos.txHash.slice(0, 16))}...`,
        ``,
      );
    }
    lines.push(`Total: ${positions.length} position(s)`);
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
      const specificChain = lastRes?.specificChain ?? trendingChainCache.get(addr.toLowerCase()) ?? null;
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
      const khOk = getHealth().subsystems.some((s) => s.name === "KeeperHub" && s.ok);
      const note = khOk
        ? "Checking safety and getting best price. MEV protection active."
        : "Checking safety and getting best price.";
      void reply(rctx, `Buying ${defaultAmount} ETH worth of ${codeAddr(addr)}...\n${note}`);
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
          const lines = [
            "<b>Wallet Created</b>\n",
            `Provider: <b>Privy</b>`,
            `EVM: ${codeAddr(wallet.address)}`,
          ];
          if (solWallet) {
            lines.push(`Solana: ${codeAddr(solWallet.address)}`);
          }
          lines.push(
            `\nEmail: <b>${emailInput}</b>`,
            `\nYour wallet is tied to this email via Privy.`,
            `Recoverable on any platform (Telegram, Discord, web).`,
            `\nFund your EVM address with ETH to start trading.`,
          );
          await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
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
        await ctx.reply(
          `That wallet is not connected. Use <code>connect 0x...</code> first.`,
          { parse_mode: "HTML" },
        );
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
        await ctx.reply(
          `Switched to: ${codeAddr(first.address)} (${first.label})`,
          { parse_mode: "HTML" },
        );
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
          console.log(`[telegram] pendingBuy intercepted — user=${userId} amount=${rawVal} ${isUsd ? "USD" : "NATIVE"} token=${pendingBuy.symbol}`);
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
      `[telegram] user=${userId} category=${result.category} confidence=${result.confidence.toFixed(2)} text="${text.slice(0, 50)}"`,
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
    if (amountRaw && typeof amountRaw === "object") {
      const v = typeof amountRaw["value"] === "number" ? amountRaw["value"] : 0;
      amount = Number.isFinite(v) && v > 0 ? v : 0;
    }
    if (amount <= 0) {
      const raw = result.rawText;
      const ethMatch = raw.match(/([\d.]+)\s*(?:\w+\s+)?(?:ETH|eth|ether)/i);
      const plainNum = raw.match(/([\d.]+)/);
      if (ethMatch) {
        amount = parseFloat(ethMatch[1]!);
      } else if (plainNum) {
        amount = parseFloat(plainNum[1]!);
      }
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

    await executeSend(rctx, userId, recipient, amount, chain.name, chain.id);
  }

  async function executeSend(
    rctx: ReplyCtx,
    userId: string,
    recipient: string,
    amount: number,
    chainName: string,
    chainId: number,
  ): Promise<void> {
    if (!wm) {
      void reply(rctx, "Wallet system not available.");
      return;
    }

    const explorer = getChainExplorer(chainName);
    const weiValue = nativeToWei(amount);

    // Check if recipient is a contract (not a wallet)
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

    await reply(
      rctx,
      [
        `<b>Sending transaction</b>`,
        `To: ${codeAddr(recipient)}`,
        `Amount: ${amount}`,
        `Chain: ${html(chainName)} (${chainId})`,
        `\nSubmitting...`,
      ].join("\n"),
    );

    try {
      const result = await wm.sendTransaction(userId, {
        to: recipient,
        value: weiValue,
        chainId,
        gasLimit: "21000",
      });
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
        system: CONVERSATIONAL_PROMPT + history + "\n\nContext for this reply: " + context,
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
    let toToken = typeof d["toToken"] === "string" ? d["toToken"] : null;
    const chainHint = typeof d["chain"] === "string" ? d["chain"] : null;

    if (chain === "solana" || chainHint === "solana") {
      void reply(rctx, "Solana trading is not supported yet. HAWKEYE currently works on EVM chains only (Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Sepolia).");
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
    const sideHint = d["side"] === "sell" ? "sell" : "buy";

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
          hlog.agent("gateway", `sell: matched position ${symbolMatch.positionId.slice(0, 8)} by symbol ${sym} on ${symbolMatch.chainId}`);
        }
        // Fallback: check conversation context
        if (!address) {
          const last = lastResearchByUser.get(userId);
          if (last && last.symbol.toUpperCase() === sym) {
            const posMatch = positions.find((p) => p.address.toLowerCase() === last.address.toLowerCase());
            if (posMatch) {
              address = posMatch.address;
              resolvedChainName = posMatch.chainId;
              chain = posMatch.chainId === "solana" ? "solana" : "evm";
              hlog.agent("gateway", `sell: matched position ${posMatch.positionId.slice(0, 8)} via research context (${sym} on ${posMatch.chainId})`);
            }
          }
        }
        // If only one position, and no address resolved yet, use it
        if (!address && positions.length === 1) {
          const only = positions[0]!;
          address = only.address;
          resolvedChainName = only.chainId;
          chain = only.chainId === "solana" ? "solana" : "evm";
          hlog.agent("gateway", `sell: only one position, using ${only.positionId.slice(0, 8)} (${only.chainId})`);
        }
      }
    }

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

    // Fallback: if no token specified, use the last researched token (within 10 min)
    if (!address) {
      const last = lastResearchByUser.get(userId);
      if (last && Date.now() - last.at < 10 * 60 * 1_000) {
        address = last.address;
        chain = last.chain;
        hlog.agent("gateway", `context: last researched ${last.symbol} (${last.address.slice(0, 10)}...)`);
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
        const matched = pairs
          .filter((p) => p.baseToken?.address?.toLowerCase() === address!.toLowerCase())
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        const best = matched[0];
        if (best) {
          verifiedTokenName = best.baseToken?.name ?? null;
          verifiedTokenSymbol = best.baseToken?.symbol ?? null;
          resolvedChainName = resolveChainAlias(best.chainId) ?? best.chainId;
          chain = best.chainId === "solana" ? "solana" : "evm";
          if (toToken && verifiedTokenSymbol) toToken = verifiedTokenSymbol;
          hlog.agent("gateway", `DexScreener verified: ${verifiedTokenSymbol} (${verifiedTokenName}) on ${best.chainId}`);
        }
      } catch { /* DexScreener lookup failed, proceed with LLM data */ }
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

    let originalUsdAmount: number | null = null;
    const specificChainEarly = resolvedChainName ?? chainHint ?? null;
    const TESTNET_SET = new Set(["sepolia", "goerli", "mumbai", "fuji", "base-sepolia", "basesepolia"]);
    const isTestnetTrade = specificChainEarly ? TESTNET_SET.has(specificChainEarly) : false;

    // Convert USD amounts to approximate native token amount
    // Testnet ETH has no real-world price — ask user to specify in ETH directly
    if (amount.unit === "USD" && amount.value > 0) {
      if (isTestnetTrade) {
        const sym = verifiedTokenSymbol ?? toToken ?? "this token";
        void reply(rctx,
          `Testnet tokens have no real-world price, so dollar amounts don't apply.\n` +
          `Specify the amount in ETH instead.\n` +
          `Example: "buy 0.01 ETH of ${html(sym)} on ${specificChainEarly}"`,
        );
        lastResearchByUser.set(userId, { address: address!, chain: chain!, ...(resolvedChainName ?? chainHint ? { specificChain: (resolvedChainName ?? chainHint)! } : {}), symbol: toToken ?? address!.slice(0, 10), at: Date.now() });
        return;
      }
      originalUsdAmount = amount.value;
      const ethPriceUsd = await fetchEthPrice().catch(() => 2500);
      const ethEquiv = amount.value / ethPriceUsd;
      hlog.agent("gateway", `$${amount.value} → ${ethEquiv.toFixed(8)} ETH (price=$${ethPriceUsd})`);
      amount = { value: ethEquiv, unit: "NATIVE" };
    }

    // Apply user's default amount when none specified
    if (amount.value <= 0) {
      const defAmt = userSettings.get(userId)?.defaultAmount;
      if (defAmt && defAmt > 0) {
        amount = { value: defAmt, unit: "NATIVE" };
      }
    }

    const sideRaw = d["side"];
    const side: "buy" | "sell" = sideRaw === "sell" ? "sell" : "buy";

    if (amount.value <= 0) {
      const sym = verifiedTokenSymbol ?? toToken ?? (address ? address.slice(0, 10) + "..." : "this token");
      const chainLabel = specificChainEarly ?? "evm";
      if (side === "sell") {
        void reply(rctx,
          `How much do you want to sell of ${html(sym)}?\n` +
          (isTestnetTrade
            ? `Example: "sell 0.005 ETH of ${html(sym)}"`
            : `Example: "sell $5 worth" or "sell 50% of ${html(sym)}"`),
        );
      } else {
        void reply(rctx,
          `How much do you want to buy of ${html(sym)} on ${html(chainLabel)}?\n` +
          (isTestnetTrade
            ? `Example: "buy 0.01 ETH of ${html(sym)} on ${html(chainLabel)}"`
            : `Example: "buy $5 worth" or "buy 0.01 ETH of ${html(sym)}"`),
        );
      }
      lastResearchByUser.set(userId, { address: address!, chain: chain!, ...(resolvedChainName ?? chainHint ? { specificChain: (resolvedChainName ?? chainHint)! } : {}), symbol: toToken ?? address!.slice(0, 10), at: Date.now() });
      return;
    }

    const urgencyRaw = d["urgency"];
    const userMode = userSettings.get(userId)?.mode;
    const urgency: TradingMode =
      urgencyRaw === "INSTANT" || urgencyRaw === "CAREFUL" ? urgencyRaw : (userMode ?? "NORMAL");

    const specificChain = resolvedChainName ?? chainHint ?? null;

    const defaultExits: TradeIntent["exits"] = side === "buy"
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
    pendingMap.set(intent.intentId, pending);
    trackToken(userId, address, specificChain ?? (chain === "evm" ? "ethereum" : chain), tokenSymbol);
    bus.emit("TRADE_REQUEST", intent);

    // Save to conversation context so "buy $2" works after "ape this 0xCA..."
    lastResearchByUser.set(userId, {
      address,
      chain,
      ...(resolvedChainName ?? chainHint ? { specificChain: (resolvedChainName ?? chainHint)! } : {}),
      symbol: toToken ?? address.slice(0, 10),
      at: Date.now(),
    });

    const displaySymbol = verifiedTokenSymbol ?? toToken;
    const displayName = verifiedTokenName;
    const tokenLabel = displaySymbol
      ? displayName
        ? `${html(displaySymbol.toUpperCase())} (${html(displayName)}) ${codeAddr(address)}`
        : `${html(displaySymbol.toUpperCase())} (${codeAddr(address)})`
      : codeAddr(address);
    const chainLabel =
      specificChain && specificChain !== chain ? `${chain} (${html(specificChain)})` : chain;
    const amountDisplay = amount.value > 0
      ? originalUsdAmount != null
        ? `$${originalUsdAmount} (~${amount.value.toFixed(6)} ETH)`
        : `${amount.value.toFixed(6)} ETH`
      : "";
    const keeperHubActive = getHealth().subsystems.some((s) => s.name === "KeeperHub" && s.ok);
    const processingNote = keeperHubActive
      ? "Checking safety and getting best price. MEV protection active."
      : "Checking safety and getting best price.";
    const isSwap = !!(fromToken && toToken) && side !== "sell";
    const actionVerb = side === "sell" ? "Selling" : isSwap ? "Swapping" : "Buying";
    const connector = isSwap ? "for" : "of";
    await reply(
      rctx,
      [
        `${actionVerb}${amountDisplay ? " " + amountDisplay + " " + connector : ""} ${tokenLabel} on ${chainLabel}...`,
        processingNote,
      ]
        .join("\n"),
    );

    if (storage && !storage.circuitOpen) {
      void storage
        .writeJson(intent.intentId, intent)
        .then((res) => {
          pending.rootHash = res.rootHash;
          hlog.og("storage", `audit intent=${intent.intentId.slice(0, 8)} root=${res.rootHash.slice(0, 14)}...`);
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

    const isTrending = /\b(trending|trend|hot|alpha|movers?|pumping|top tokens?)\b/i.test(result.rawText);
    if (address) {
      void reply(rctx, `Looking up ${codeAddr(address)}...`);
    } else if (isTrending) {
      void reply(rctx, "Finding what's hot right now...");
    } else {
      void reply(rctx, "Looking into that. Paste a contract address for a full breakdown.");
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
    let portfolioUsd = 0;
    const fetches = chains.map(async (chain) => {
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
    });

    const balanceLines = (await Promise.all(fetches)).filter((l): l is string => l !== null);

    const positions = getPositionsByUser(userId);
    const posLines: string[] = [];
    if (positions.length > 0) {
      posLines.push(``, `<b>Open Positions (${positions.length})</b>`);
      for (const pos of positions) {
        const label = pos.symbol ? `${pos.symbol} ` : "";
        posLines.push(
          `  ${label}${pos.address.slice(0, 10)}... (${getChainName(pos.chainId)}) | Entry: $${pos.entryPriceUsd.toFixed(6)}`,
        );
      }
    }

    if (balanceLines.length === 0 && positions.length === 0) {
      void reply(
        rctx,
        [
          `Wallet: ${codeAddr(addr)} (${config.mode})`,
          ``,
          `No balances or positions found. Send some ETH to your wallet to start trading.`,
        ].join("\n"),
      );
      return;
    }

    const totalLine = portfolioUsd >= 0.01 ? [``, `<b>Total: ~$${formatUsd(portfolioUsd)}</b>`] : [];
    void reply(
      rctx,
      [
        `<b>Portfolio</b>`,
        `Wallet: ${codeAddr(addr)} (${config.mode})`,
        ``,
        ...(balanceLines.length > 0 ? [`<b>Balances</b>`, ...balanceLines, ...totalLine] : []),
        ...posLines,
      ].join("\n"),
    );
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
        void reply(rctx, `<b>Mode set: ${friendlyName}</b>\n${MODE_DESC[mode]}`);
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
        system: CONVERSATIONAL_PROMPT + userContext + history,
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
    const isGreeting = /^(hi|hey|hello|yo|sup|gm|good\s*(morning|evening|afternoon))[\s!.]*$/i.test(lower);

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
