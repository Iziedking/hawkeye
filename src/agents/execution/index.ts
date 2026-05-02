import { bus } from "../../shared/event-bus";
import { envOr } from "../../shared/env";
import type {
  TradeIntent,
  Quote,
  StrategyDecision,
  Position,
  ExecuteSellPayload,
  TradeAmount,
} from "../../shared/types";
import type { WalletManager } from "../../integrations/privy/index";
import type { KeeperHubClient } from "../../integrations/keeperhub/index";
import { randomUUID } from "node:crypto";
import { fetchTokenBalance } from "../../shared/evm-chains";
import {
  loadPositions,
  getPosition,
  setPosition,
  deletePosition,
  getAllPositions,
  getPositionsByUser as getPositionsByUserInternal,
} from "./position-store";

const CACHE_TTL_MS = 5 * 60 * 1_000;

interface IntentContext {
  intent: TradeIntent;
  quote?: Quote;
  cachedAt: number;
}

const contextCache = new Map<string, IntentContext>();

function pruneCache(): void {
  const now = Date.now();
  for (const [id, ctx] of contextCache) {
    if (now - ctx.cachedAt > CACHE_TTL_MS) contextCache.delete(id);
  }
}

const CHAIN_NUMERIC: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  bsc: 56,
  avalanche: 43114,
  fantom: 250,
  cronos: 25,
  zksync: 324,
  linea: 59144,
  blast: 81457,
  scroll: 534352,
  mantle: 5000,
  celo: 42220,
  sepolia: 11155111,
  "base-sepolia": 84532,
  basesepolia: 84532,
};

function humanizeQuoteError(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { errorCode?: string; detail?: string; error?: string; code?: string };
    const detail = parsed.detail ?? parsed.error ?? parsed.errorCode ?? "";
    if (detail.includes("No quotes available") || status === 404) {
      return "No swap route found. The token might not be tradeable on this chain, or your wallet may not have enough native tokens for gas. Fund your wallet and try again.";
    }
    if (detail.includes("INSUFFICIENT") || detail.includes("insufficient")) {
      return "Insufficient balance. Fund your wallet with native tokens (ETH/MATIC/etc.) and try again.";
    }
    if (detail.includes("Execution reverted") || detail.includes("execution reverted") || parsed.code === "transaction_broadcast_failure") {
      return "Transaction reverted on-chain. Most likely your wallet doesn't hold enough of this token to sell, or doesn't have enough ETH for gas. Check your balance and try again.";
    }
    if (status === 429) return "Uniswap rate limited. Try again in a few seconds.";
    if (status >= 500) return "Uniswap API is temporarily down. Try again shortly.";
    return `Swap failed: ${detail || `error ${status}`}. Try again or adjust your amount.`;
  } catch {
    if (status === 404) return "No swap route found for this token. It may not be listed on Uniswap for this chain.";
    if (raw.includes("execution reverted") || raw.includes("Execution reverted")) {
      return "Transaction reverted on-chain. Your wallet may not hold this token or may lack gas. Check your balance and try again.";
    }
    return `Swap failed (error ${status}). Try again shortly.`;
  }
}

function nativeToWei(amount: number): string {
  const parts = amount.toFixed(18).split(".");
  const whole = parts[0] ?? "0";
  const frac = (parts[1] ?? "").padEnd(18, "0").slice(0, 18);
  return (BigInt(whole) * BigInt("1000000000000000000") + BigInt(frac)).toString();
}

interface ExecutionReceipt {
  txHash: string;
  confirmedAt: number;
  filledAmount: TradeAmount;
  actualPriceUsd: number;
  mevProtected?: boolean;
}

export type ExecutionAgentDeps = {
  walletManager?: WalletManager | null;
  keeperHub?: KeeperHubClient | null;
};

let walletMgr: WalletManager | null = null;
let keeperHubClient: KeeperHubClient | null = null;

const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
const UNISWAP_API = "https://trade-api.gateway.uniswap.org/v1";
const WALLET_TIMEOUT_MS = 20_000;

const TESTNET_CHAINS = new Set(["sepolia", "base-sepolia", "basesepolia"]);

function isMainnet(chainId: string): boolean {
  return !TESTNET_CHAINS.has(chainId);
}

async function logToKeeperHub(
  action: "swap" | "approval" | "sell",
  chainId: number,
  txHash: string,
  tokenAddress: string,
): Promise<void> {
  if (!keeperHubClient || keeperHubClient.circuitOpen) return;
  try {
    const network = keeperHubClient.networkFromChainId(chainId);
    await keeperHubClient.getExecutionStatus(`hawkeye-${action}-${txHash.slice(0, 10)}`).catch(() => {});
    console.log(`[execution] KeeperHub: logged ${action} on ${network} tx=${txHash.slice(0, 12)}...`);
  } catch {
    // monitoring is best-effort, don't block trade flow
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const UNISWAP_HEADERS = (apiKey: string) => ({
  "Content-Type": "application/json",
  "x-api-key": apiKey,
  "x-universal-router-version": "2.0",
});

function isUniswapXRoute(routing: unknown): boolean {
  return routing === "DUTCH_V2" || routing === "DUTCH_V3" || routing === "PRIORITY";
}

function validateSwapResponse(swap: { to?: string; data?: string; value?: string }): void {
  if (!swap.data || swap.data === "" || swap.data === "0x") {
    throw new Error("swap.data is empty — quote may have expired, re-fetch");
  }
  if (!swap.to || !/^0x[a-fA-F0-9]{40}$/.test(swap.to)) {
    throw new Error(`swap.to is not a valid address: ${swap.to}`);
  }
}

function prepareSwapRequest(
  quoteResponse: Record<string, unknown>,
  permit2Signature?: string,
): Record<string, unknown> {
  const { permitData, permitTransaction: _, ...cleanQuote } = quoteResponse;
  const request: Record<string, unknown> = { ...cleanQuote };

  if (isUniswapXRoute(quoteResponse["routing"])) {
    if (permit2Signature) request["signature"] = permit2Signature;
  } else {
    if (permit2Signature && permitData && typeof permitData === "object") {
      request["signature"] = permit2Signature;
      request["permitData"] = permitData;
    }
  }

  return request;
}

async function checkAndSubmitApproval(
  tokenIn: string,
  amount: string,
  walletAddress: string,
  chainId: number,
  apiKey: string,
  userId: string,
): Promise<void> {
  if (tokenIn === ETH_ADDRESS) return;

  const resp = await fetch(`${UNISWAP_API}/check_approval`, {
    method: "POST",
    headers: UNISWAP_HEADERS(apiKey),
    body: JSON.stringify({
      walletAddress,
      token: tokenIn,
      amount,
      chainId,
      
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    console.warn(`[execution] check_approval ${resp.status}: ${err.slice(0, 120)}`);
    return;
  }

  const data = (await resp.json()) as { approval?: { to?: string; data?: string; value?: string } | null };

  if (!data.approval) {
    console.log("[execution] token already approved for Permit2");
    return;
  }

  if (!walletMgr) throw new Error("Wallet manager not available for token approval");

  console.log("[execution] submitting approval tx...");
  const result = await walletMgr.sendTransaction(userId, {
    to: data.approval.to ?? "",
    data: data.approval.data ?? "",
    value: data.approval.value ?? "0",
    chainId,
  });
  console.log(`[execution] approval confirmed: ${result.hash.slice(0, 16)}...`);
}

async function executeEvmSwap(
  intent: TradeIntent,
  quote: Quote,
): Promise<ExecutionReceipt> {
  const numChainId = CHAIN_NUMERIC[quote.chainId] ?? 1;
  const apiKey = envOr("UNISWAP_API_KEY", "");

  if (!apiKey) {
    throw new Error("UNISWAP_API_KEY not configured");
  }

  const swapperAddress = walletMgr?.walletAddress(intent.userId);
  if (!swapperAddress) {
    throw new Error(`No wallet for user ${intent.userId}`);
  }

  const isSell = intent.side === "sell";
  const tokenIn = isSell ? intent.address : ETH_ADDRESS;
  const tokenOut = isSell ? ETH_ADDRESS : intent.address;

  // Pre-check: verify wallet holds the token before attempting a sell
  if (isSell) {
    const { balance: tokenBal, error: balErr } = await fetchTokenBalance(
      quote.chainId, tokenIn, swapperAddress, 5_000,
    ).catch(() => ({ balance: 0n, error: "fetch_failed" }));

    if (!balErr && tokenBal === 0n) {
      throw new Error(
        `Your wallet doesn't hold any of this token on ${quote.chainId}. ` +
        `Buy it first, then sell. Use /wallet to check your balances.`,
      );
    }
    if (tokenBal > 0n) {
      console.log(`[execution] token balance check: ${tokenBal.toString()} raw units on ${quote.chainId}`);
    }
  }

  // For buys: amount is in ETH (NATIVE), convert to wei for EXACT_INPUT
  // For sells: amount is in ETH the user wants back, use EXACT_OUTPUT
  const amountWei = intent.amount.unit === "NATIVE"
    ? nativeToWei(intent.amount.value)
    : String(Math.round(intent.amount.value * 1e6));

  if (amountWei === "0" || intent.amount.value <= 0) {
    throw new Error("No trade amount specified. Use /mode to set a default amount, or say 'buy 0.01 ETH of [token]'.");
  }

  // Step 1: Check approval (skipped for native ETH, required for token sells)
  // For sells, approve a large amount so Permit2 can spend the token
  if (isSell) {
    const MAX_UINT = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    await checkAndSubmitApproval(tokenIn, MAX_UINT, swapperAddress, numChainId, apiKey, intent.userId);
  } else {
    await checkAndSubmitApproval(tokenIn, amountWei, swapperAddress, numChainId, apiKey, intent.userId);
  }

  // Step 2: Get quote (chainId as string per Uniswap API spec)
  // Sells use EXACT_OUTPUT (specifying how much ETH/native to receive)
  const quoteResp = await fetch(`${UNISWAP_API}/quote`, {
    method: "POST",
    headers: UNISWAP_HEADERS(apiKey),
    body: JSON.stringify({
      swapper: swapperAddress,
      tokenIn,
      tokenOut,
      tokenInChainId: String(numChainId),
      tokenOutChainId: String(numChainId),
      amount: amountWei,
      type: isSell ? "EXACT_OUTPUT" : "EXACT_INPUT",
      slippageTolerance: parseFloat(quote.expectedSlippagePct.toFixed(2)),
      routingPreference: "BEST_PRICE",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!quoteResp.ok) {
    const raw = await quoteResp.text().catch(() => "");
    console.error(`[execution] Uniswap quote ${quoteResp.status}: ${raw.slice(0, 300)}`);
    throw new Error(humanizeQuoteError(quoteResp.status, raw));
  }

  const quoteData = (await quoteResp.json()) as Record<string, unknown>;
  const routingType = quoteData["routing"] as string ?? "CLASSIC";
  console.log(`[execution] Uniswap routing: ${routingType}`);

  // Step 3: Prepare and submit swap — routing-aware Permit2 handling
  const swapRequest = prepareSwapRequest(quoteData);

  const swapResp = await fetch(`${UNISWAP_API}/swap`, {
    method: "POST",
    headers: UNISWAP_HEADERS(apiKey),
    body: JSON.stringify(swapRequest),
    signal: AbortSignal.timeout(10_000),
  });

  if (!swapResp.ok) {
    const raw = await swapResp.text().catch(() => "");
    console.error(`[execution] Uniswap swap ${swapResp.status}: ${raw.slice(0, 300)}`);
    throw new Error(humanizeQuoteError(swapResp.status, raw));
  }

  const swapData = (await swapResp.json()) as {
    swap?: { to?: string; data?: string; value?: string };
  };

  if (!swapData.swap) {
    throw new Error("Uniswap returned no swap object");
  }

  validateSwapResponse(swapData.swap);

  if (!walletMgr) throw new Error("Wallet manager not available");

  const txParams: import("../../integrations/privy/index").SignTxInput = {
    to: swapData.swap.to!,
    data: swapData.swap.data!,
    value: swapData.swap.value ?? "0",
    chainId: numChainId,
  };

  const mainnet = isMainnet(quote.chainId);
  const khActive = mainnet && keeperHubClient !== null && !keeperHubClient.circuitOpen;
  if (khActive) {
    console.log(`[execution] KeeperHub active for ${quote.chainId} — MEV protection enabled`);
  }

  console.log(`[execution] submitting swap transaction...`);
  let result: { hash: string };
  try {
    result = await withTimeout(
      walletMgr.sendTransaction(intent.userId, txParams),
      WALLET_TIMEOUT_MS,
      "sendTransaction",
    );
  } catch (txErr) {
    const msg = String((txErr as Error).message ?? txErr);
    console.error(`[execution] sendTransaction failed: ${msg.slice(0, 300)}`);
    if (msg.includes("execution reverted") || msg.includes("Execution reverted")) {
      const hint = isSell
        ? "Transaction reverted. Possible causes:\n" +
          "1. Token may have sell restrictions or high sell tax (honeypot)\n" +
          "2. Insufficient ETH for gas\n" +
          "3. Slippage too low for this token\n" +
          "Check the token's safety score before selling. Use /balance to verify holdings."
        : "Transaction reverted. Your wallet may not have enough ETH for this swap. Fund your wallet and try again.";
      throw new Error(hint);
    }
    throw txErr;
  }
  console.log(`[execution] submitted (${routingType}): ${result.hash.slice(0, 16)}...`);

  if (khActive) {
    void logToKeeperHub(isSell ? "sell" : "swap", numChainId, result.hash, intent.address);
  }

  return {
    txHash: result.hash,
    confirmedAt: Date.now(),
    filledAmount: intent.amount,
    actualPriceUsd: quote.priceUsd,
    mevProtected: khActive,
  };
}

async function executeSolanaSwap(
  intent: TradeIntent,
  quote: Quote,
): Promise<ExecutionReceipt> {
  const slippageBps = Math.floor(quote.expectedSlippagePct * 100);
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const isSell = intent.side === "sell";
  const inputMint = isSell ? intent.address : SOL_MINT;
  const outputMint = isSell ? SOL_MINT : intent.address;

  const jupQuoteReq = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${intent.amount.value}&slippageBps=${slippageBps}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!jupQuoteReq.ok) {
    throw new Error(`Jupiter quote failed: ${jupQuoteReq.status}`);
  }
  const jupQuote = await jupQuoteReq.json();

  const jupSwapReq = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: jupQuote,
      userPublicKey: envOr("SOLANA_WALLET_ADDRESS", ""),
      wrapAndUnwrapSol: true,
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!jupSwapReq.ok) {
    throw new Error(`Jupiter swap failed: ${jupSwapReq.status}`);
  }

  // Solana signing/submission requires a different wallet flow (not Privy EVM)
  const txHash = `sol-pending-${randomUUID().slice(0, 8)}`;

  return {
    txHash,
    confirmedAt: Date.now(),
    filledAmount: intent.amount,
    actualPriceUsd: quote.priceUsd,
  };
}

async function handleExecute(intentId: string): Promise<void> {
  console.log(`[execution] handleExecute called for ${intentId.slice(0, 8)}...`);
  const ctx = contextCache.get(intentId);
  if (!ctx) {
    console.error(`[execution] no context for ${intentId} — cached IDs: [${[...contextCache.keys()].map(k => k.slice(0, 8)).join(", ")}]`);
    bus.emit("QUOTE_FAILED", { intentId, address: "", reason: "Execution context lost. Try again." });
    return;
  }

  const { intent, quote } = ctx;
  if (!quote) {
    console.error(`[execution] no quote for ${intentId}`);
    bus.emit("QUOTE_FAILED", { intentId, address: intent.address, reason: "Quote not received in time. Try again." });
    return;
  }

  // Handle user-initiated sell: use tracked position if available, otherwise
  // execute a direct sell swap (user may have bought externally or bot restarted)
  if (intent.side === "sell") {
    const userPositions = getPositionsByUserInternal(intent.userId).filter(
      (p) => p.address.toLowerCase() === intent.address.toLowerCase(),
    );
    if (userPositions.length > 0) {
      const pos = userPositions[0]!;
      await handleSell({ positionId: pos.positionId, fraction: 1.0, triggeredBy: { kind: "multiplier", value: 0 }, emittedAt: Date.now() });
      contextCache.delete(intentId);
      return;
    }
    // No tracked position: execute sell swap directly (token → native)
    console.log(`[execution] sell without tracked position — direct swap for ${intent.address.slice(0, 10)}...`);
  }

  console.log(`[execution] ${intent.chain} swap ${intent.address.slice(0, 10)}... for user ${intent.userId}`);

  let receipt: ExecutionReceipt;
  try {
    if (intent.chain === "evm") {
      receipt = await executeEvmSwap(intent, quote);
    } else {
      receipt = await executeSolanaSwap(intent, quote);
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[execution] failed: ${msg.slice(0, 120)}`);
    bus.emit("QUOTE_FAILED", {
      intentId,
      address: intent.address,
      reason: msg.slice(0, 200),
    });
    contextCache.delete(intentId);
    return;
  }

  const position: Position = {
    intentId,
    positionId: randomUUID(),
    userId: intent.userId,
    address: intent.address,
    chainId: quote.chainId,
    filled: receipt.filledAmount,
    entryPriceUsd: receipt.actualPriceUsd,
    txHash: receipt.txHash,
    remainingExits: [...intent.exits],
    openedAt: receipt.confirmedAt,
    ...(intent.symbol ? { symbol: intent.symbol } : {}),
    ...(receipt.mevProtected ? { mevProtected: true } : {}),
  };

  setPosition(position.positionId, position);
  bus.emit("TRADE_EXECUTED", position);
  contextCache.delete(intentId);

  console.log(`[execution] done tx=${receipt.txHash.slice(0, 16)}...`);
}

async function handleSell(payload: ExecuteSellPayload): Promise<void> {
  const position = getPosition(payload.positionId);
  if (!position) {
    console.warn(`[execution] sell: unknown position ${payload.positionId}`);
    return;
  }

  console.log(`[execution] sell ${payload.fraction * 100}% of ${position.address.slice(0, 10)}...`);

  // Sell = swap token back to native
  const sellIntent: TradeIntent = {
    intentId: randomUUID(),
    userId: position.userId,
    channel: "telegram",
    address: position.address,
    chain: position.address.startsWith("0x") ? "evm" : "solana",
    amount: {
      value: position.filled.value * payload.fraction,
      unit: position.filled.unit,
    },
    exits: [],
    urgency: "NORMAL",
    rawText: `auto-sell ${payload.fraction * 100}%`,
    createdAt: Date.now(),
    side: "sell",
  };

  const sellQuote: Quote = {
    intentId: sellIntent.intentId,
    address: position.address,
    chainId: position.chainId,
    pairAddress: "",
    priceUsd: position.entryPriceUsd,
    liquidityUsd: 0,
    expectedSlippagePct: 1,
    feeEstimateUsd: 0,
    route: "auto-sell",
    completedAt: Date.now(),
  };

  try {
    let receipt: ExecutionReceipt;
    if (sellIntent.chain === "evm") {
      receipt = await executeEvmSwap(sellIntent, sellQuote);
    } else {
      receipt = await executeSolanaSwap(sellIntent, sellQuote);
    }
    console.log(`[execution] sell done tx=${receipt.txHash.slice(0, 16)}...`);

    const soldPosition: Position = {
      ...position,
      txHash: receipt.txHash,
      filled: { value: position.filled.value * payload.fraction, unit: position.filled.unit },
    };
    bus.emit("TRADE_EXECUTED", soldPosition);

    if (payload.fraction >= 1) {
      deletePosition(payload.positionId);
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[execution] sell failed: ${msg.slice(0, 100)}`);
    bus.emit("QUOTE_FAILED", {
      intentId: position.intentId,
      address: position.address,
      reason: `Sell failed: ${msg.slice(0, 150)}`,
    });
  }
}

export function startExecutionAgent(deps: ExecutionAgentDeps = {}): () => void {
  loadPositions();
  walletMgr = deps.walletManager ?? null;
  keeperHubClient = deps.keeperHub ?? null;

  if (!walletMgr) {
    console.warn("[execution] no wallet manager — trades will fail");
  }
  if (keeperHubClient) {
    console.log("[execution] KeeperHub active — checking connectivity...");
    keeperHubClient.checkReachable().then((ok) => {
      if (ok) console.log("[execution] KeeperHub reachable — all mainnet swaps will be MEV-protected");
      else console.warn("[execution] KeeperHub unreachable — mainnet swaps will proceed without MEV protection");
    }).catch(() => {});
  }

  const onTradeRequest = (intent: TradeIntent) => {
    pruneCache();
    contextCache.set(intent.intentId, { intent, cachedAt: Date.now() });
  };

  const onQuoteResult = (quote: Quote) => {
    const ctx = contextCache.get(quote.intentId);
    if (ctx) ctx.quote = quote;
  };

  const onStrategyDecision = (decision: StrategyDecision) => {
    if (decision.decision !== "EXECUTE") return;
    handleExecute(decision.intentId).catch((err) => {
      console.error(`[execution] UNHANDLED in handleExecute: ${(err as Error).message}`);
      bus.emit("QUOTE_FAILED", {
        intentId: decision.intentId,
        address: "",
        reason: `Execution crashed: ${(err as Error).message?.slice(0, 150) ?? "unknown error"}`,
      });
    });
  };

  const onExecuteSell = (payload: ExecuteSellPayload) => {
    handleSell(payload).catch((err) => {
      console.error(`[execution] UNHANDLED in handleSell: ${(err as Error).message}`);
    });
  };

  bus.on("TRADE_REQUEST", onTradeRequest);
  bus.on("QUOTE_RESULT", onQuoteResult);
  bus.on("STRATEGY_DECISION", onStrategyDecision);
  bus.on("EXECUTE_SELL", onExecuteSell);

  console.log("[execution] listening for STRATEGY_DECISION / EXECUTE_SELL");

  return () => {
    bus.off("TRADE_REQUEST", onTradeRequest);
    bus.off("QUOTE_RESULT", onQuoteResult);
    bus.off("STRATEGY_DECISION", onStrategyDecision);
    bus.off("EXECUTE_SELL", onExecuteSell);
  };
}

export function getPositions(): Position[] {
  return getAllPositions();
}

export { getPositionsByUser } from "./position-store";
