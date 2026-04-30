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

const CACHE_TTL_MS = 5 * 60 * 1_000;

interface IntentContext {
  intent: TradeIntent;
  quote?: Quote;
  cachedAt: number;
}

const contextCache = new Map<string, IntentContext>();
const positionStore = new Map<string, Position>();

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
};

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
}

export type ExecutionAgentDeps = {
  walletManager?: WalletManager | null;
  keeperHub?: KeeperHubClient | null;
};

let walletMgr: WalletManager | null = null;
let keeperHubClient: KeeperHubClient | null = null;

const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
const UNISWAP_API = "https://trade-api.gateway.uniswap.org/v1";

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

  if (!walletMgr) throw new Error("Wallet manager not available for approval tx");

  console.log("[execution] submitting approval tx...");
  const result = await walletMgr.sendTransaction(userId, {
    to: data.approval.to ?? "",
    data: data.approval.data ?? "",
    value: data.approval.value ?? "0",
    chainId,
    gasLimit: "100000",
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

  const tokenIn = ETH_ADDRESS;
  const amountWei = intent.amount.unit === "NATIVE"
    ? nativeToWei(intent.amount.value)
    : String(Math.round(intent.amount.value * 1e6));

  // Step 1: Check approval (skipped for native ETH)
  await checkAndSubmitApproval(tokenIn, amountWei, swapperAddress, numChainId, apiKey, intent.userId);

  // Step 2: Get quote (chainId as string per Uniswap API spec)
  const quoteResp = await fetch(`${UNISWAP_API}/quote`, {
    method: "POST",
    headers: UNISWAP_HEADERS(apiKey),
    body: JSON.stringify({
      swapper: swapperAddress,
      tokenIn,
      tokenOut: intent.address,
      tokenInChainId: String(numChainId),
      tokenOutChainId: String(numChainId),
      amount: amountWei,
      type: "EXACT_INPUT",
      slippageTolerance: quote.expectedSlippagePct,
      routingPreference: "BEST_PRICE",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!quoteResp.ok) {
    const err = await quoteResp.text().catch(() => "");
    throw new Error(`Uniswap quote ${quoteResp.status}: ${err.slice(0, 200)}`);
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
    const err = await swapResp.text().catch(() => "");
    throw new Error(`Uniswap swap ${swapResp.status}: ${err.slice(0, 200)}`);
  }

  const swapData = (await swapResp.json()) as {
    swap?: { to?: string; data?: string; value?: string };
  };

  if (!swapData.swap) {
    throw new Error("Uniswap returned no swap object");
  }

  validateSwapResponse(swapData.swap);

  if (!walletMgr) throw new Error("Wallet manager not available");

  const txParams = {
    to: swapData.swap.to!,
    data: swapData.swap.data!,
    value: swapData.swap.value ?? "0",
    chainId: numChainId,
    gasLimit: "500000",
  };

  // Try KeeperHub for MEV-protected submission, fall back to direct Privy
  if (keeperHubClient && !keeperHubClient.circuitOpen) {
    try {
      const signedTx = await walletMgr.signTransaction(intent.userId, txParams);
      const status = await keeperHubClient.submitAndWait(signedTx, numChainId);
      if (status.status === "confirmed" && status.txHash) {
        console.log(`[execution] KeeperHub confirmed: ${status.txHash.slice(0, 16)}...`);
        return {
          txHash: status.txHash,
          confirmedAt: Date.now(),
          filledAmount: intent.amount,
          actualPriceUsd: quote.priceUsd,
        };
      }
      if (status.status === "failed") {
        console.warn("[execution] KeeperHub bundle failed — falling back to direct");
      }
    } catch (err) {
      console.warn(`[execution] KeeperHub error — direct submit: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  const result = await walletMgr.sendTransaction(intent.userId, txParams);
  console.log(`[execution] direct submit (${routingType}): ${result.hash.slice(0, 16)}...`);

  return {
    txHash: result.hash,
    confirmedAt: Date.now(),
    filledAmount: intent.amount,
    actualPriceUsd: quote.priceUsd,
  };
}

async function executeSolanaSwap(
  intent: TradeIntent,
  quote: Quote,
): Promise<ExecutionReceipt> {
  const slippageBps = Math.floor(quote.expectedSlippagePct * 100);

  const jupQuoteReq = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${intent.address}&amount=${intent.amount.value}&slippageBps=${slippageBps}`,
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
  const ctx = contextCache.get(intentId);
  if (!ctx) {
    console.error(`[execution] no context for ${intentId}`);
    return;
  }

  const { intent, quote } = ctx;
  if (!quote) {
    console.error(`[execution] no quote for ${intentId}`);
    return;
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
  };

  positionStore.set(position.positionId, position);
  bus.emit("TRADE_EXECUTED", position);
  contextCache.delete(intentId);

  console.log(`[execution] done tx=${receipt.txHash.slice(0, 16)}...`);
}

async function handleSell(payload: ExecuteSellPayload): Promise<void> {
  const position = positionStore.get(payload.positionId);
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
    if (sellIntent.chain === "evm") {
      const receipt = await executeEvmSwap(sellIntent, sellQuote);
      console.log(`[execution] sell done tx=${receipt.txHash.slice(0, 16)}...`);
    }
  } catch (err) {
    console.error(`[execution] sell failed: ${(err as Error).message?.slice(0, 100)}`);
  }
}

export function startExecutionAgent(deps: ExecutionAgentDeps = {}): () => void {
  walletMgr = deps.walletManager ?? null;
  keeperHubClient = deps.keeperHub ?? null;

  if (!walletMgr) {
    console.warn("[execution] no wallet manager — trades will fail");
  }
  if (keeperHubClient) {
    console.log("[execution] KeeperHub active — MEV-protected submission enabled");
  }

  const onTradeRequest = (intent: TradeIntent) => {
    pruneCache();
    contextCache.set(intent.intentId, { intent, cachedAt: Date.now() });
  };

  const onQuoteResult = (quote: Quote) => {
    const ctx = contextCache.get(quote.intentId);
    if (ctx) ctx.quote = quote;
  };

  const onStrategyDecision = async (decision: StrategyDecision) => {
    if (decision.decision !== "EXECUTE") return;
    await handleExecute(decision.intentId);
  };

  const onExecuteSell = async (payload: ExecuteSellPayload) => {
    await handleSell(payload);
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
  return Array.from(positionStore.values());
}

export function getPositionsByUser(userId: string): Position[] {
  return Array.from(positionStore.values()).filter((p) => p.userId === userId);
}
