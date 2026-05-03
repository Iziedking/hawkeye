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
import { recordTrade, loadTradeHistory } from "../../shared/trade-history";
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
    const parsed = JSON.parse(raw) as {
      errorCode?: string;
      detail?: string;
      error?: string;
      code?: string;
    };
    const detail = parsed.detail ?? parsed.error ?? parsed.errorCode ?? "";
    if (detail.includes("No quotes available") || status === 404) {
      return "No swap route found. The token might not be tradeable on this chain, or your wallet may not have enough native tokens for gas. Fund your wallet and try again.";
    }
    if (detail.includes("INSUFFICIENT") || detail.includes("insufficient")) {
      return "Insufficient balance. Fund your wallet with native tokens (ETH/MATIC/etc.) and try again.";
    }
    if (
      detail.includes("Execution reverted") ||
      detail.includes("execution reverted") ||
      parsed.code === "transaction_broadcast_failure"
    ) {
      return "Transaction reverted on-chain. Most likely your wallet doesn't hold enough of this token to sell, or doesn't have enough ETH for gas. Check your balance and try again.";
    }
    if (status === 429) return "Uniswap rate limited. Try again in a few seconds.";
    if (status >= 500) return "Uniswap API is temporarily down. Try again shortly.";
    return `Swap failed: ${detail || `error ${status}`}. Try again or adjust your amount.`;
  } catch {
    if (status === 404)
      return "No swap route found for this token. It may not be listed on Uniswap for this chain.";
    if (raw.includes("execution reverted") || raw.includes("Execution reverted")) {
      return "Transaction reverted on-chain. Your wallet may not hold this token or may lack gas. Check your balance and try again.";
    }
    return `Swap failed (error ${status}). Try again shortly.`;
  }
}

function toSmallestUnit(amount: number, decimals: number = 18): string {
  const fixed = amount.toFixed(decimals);
  const parts = fixed.split(".");
  const whole = parts[0] ?? "0";
  const frac = (parts[1] ?? "").padEnd(decimals, "0").slice(0, decimals);
  const multiplier = BigInt("1" + "0".repeat(decimals));
  return (BigInt(whole) * multiplier + BigInt(frac)).toString();
}

function nativeToWei(amount: number): string {
  return toSmallestUnit(amount, 18);
}

const STABLECOIN_ADDRESSES = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // ETH USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // ETH USDT
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // Base USDT
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Arb USDC
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // Arb USDT
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // OP USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // Polygon USDC
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // BSC USDC
  "0x55d398326f99059ff775485246999027b3197955", // BSC USDT
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", // Sepolia USDC
]);

function getTokenDecimals(address: string): number {
  if (address === ETH_ADDRESS) return 18;
  if (STABLECOIN_ADDRESSES.has(address.toLowerCase())) return 6;
  return 18;
}

const MAX_SLIPPAGE_PCT = 5;

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
  _tokenAddress: string,
): Promise<void> {
  if (!keeperHubClient || keeperHubClient.circuitOpen) return;
  try {
    const network = keeperHubClient.networkFromChainId(chainId);
    await keeperHubClient
      .getExecutionStatus(`hawkeye-${action}-${txHash.slice(0, 10)}`)
      .catch(() => {});
    console.log(
      `[execution] KeeperHub: logged ${action} on ${network} tx=${txHash.slice(0, 12)}...`,
    );
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

  const data = (await resp.json()) as {
    approval?: { to?: string; data?: string; value?: string } | null;
  };

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

async function executeEvmSwap(intent: TradeIntent, quote: Quote): Promise<ExecutionReceipt> {
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
  const hasFromToken = !!intent.fromTokenAddress;
  const tokenIn = hasFromToken ? intent.fromTokenAddress! : isSell ? intent.address : ETH_ADDRESS;
  const tokenOut = hasFromToken ? intent.address : isSell ? ETH_ADDRESS : intent.address;

  // Read on-chain balance for any swap whose input is an ERC-20 (sells, swaps).
  // This is the source of truth for sell amount resolution.
  let onchainBalance = 0n;
  if (isSell || hasFromToken) {
    const { balance, error: balErr } = await fetchTokenBalance(
      quote.chainId,
      tokenIn,
      swapperAddress,
      5_000,
    ).catch(() => ({ balance: 0n, error: "fetch_failed" }));

    if (!balErr) onchainBalance = balance;

    if (!balErr && balance === 0n) {
      throw new Error(
        `Your wallet doesn't hold any of this token on ${quote.chainId}. ` +
          `Buy it first, then sell. Use /wallet to check your balances.`,
      );
    }
    if (balance > 0n) {
      console.log(
        `[execution] on-chain balance: ${balance.toString()} raw units on ${quote.chainId}`,
      );
    }
  }

  const inputDecimals = getTokenDecimals(tokenIn);
  const outputDecimals = getTokenDecimals(tokenOut);

  // Resolve the swap amount + Uniswap "type" (EXACT_INPUT vs EXACT_OUTPUT).
  // For sells we ALWAYS use EXACT_INPUT against an on-chain-derived token amount,
  // so the user can never request more tokens than they hold and so the math
  // is independent of token decimals quirks.
  let amountRaw: string;
  const swapType: "EXACT_INPUT" | "EXACT_OUTPUT" = "EXACT_INPUT";

  if (isSell || hasFromToken) {
    // PERCENT and "all" → fraction of on-chain balance.
    if (intent.amount.unit === "PERCENT") {
      const pct = Math.max(0, Math.min(100, intent.amount.value));
      const tokensRaw = (onchainBalance * BigInt(Math.floor(pct * 100))) / 10_000n;
      if (tokensRaw === 0n) {
        throw new Error(
          `Cannot sell ${pct}% — wallet holds 0 raw units of this token on ${quote.chainId}.`,
        );
      }
      amountRaw = tokensRaw.toString();
    } else if (intent.amount.unit === "TOKEN") {
      // Exact token amount in display units.
      const tokensRaw = BigInt(toSmallestUnit(intent.amount.value, inputDecimals));
      // Cap at on-chain balance so a slightly-stale "sell 100 PEPE" still works.
      amountRaw = (tokensRaw > onchainBalance ? onchainBalance : tokensRaw).toString();
    } else if (intent.amount.unit === "USD") {
      // "$10 of TOKEN" → token amount via current price.
      if (!quote.priceUsd || quote.priceUsd <= 0) {
        throw new Error("No live USD price available; can't size the sell.");
      }
      const tokens = intent.amount.value / quote.priceUsd;
      const tokensRaw = BigInt(toSmallestUnit(tokens, inputDecimals));
      amountRaw = (tokensRaw > onchainBalance ? onchainBalance : tokensRaw).toString();
    } else {
      // NATIVE — "sell 0.005 ETH worth": infer tokens from ETH-equivalent.
      // priceUsd in quote is the token price; we need tokens = ethValue * ethUsd / tokenUsd.
      // For a clean fallback we treat NATIVE as a synonym for "this many ETH worth"
      // and compute via priceUsd against the well-known ETH price ~$2500.
      const ethUsd = 2500;
      const usd = intent.amount.value * ethUsd;
      if (!quote.priceUsd || quote.priceUsd <= 0) {
        throw new Error("No live price available; can't size the sell.");
      }
      const tokens = usd / quote.priceUsd;
      const tokensRaw = BigInt(toSmallestUnit(tokens, inputDecimals));
      amountRaw = (tokensRaw > onchainBalance ? onchainBalance : tokensRaw).toString();
    }
  } else {
    // BUY path: input is ETH, amount is in ETH or USD.
    if (intent.amount.unit === "USD") {
      const ethUsd = 2500;
      const ethValue = intent.amount.value / ethUsd;
      amountRaw = toSmallestUnit(ethValue, 18);
    } else {
      // NATIVE (ETH): 18 decimals.
      amountRaw = toSmallestUnit(intent.amount.value, 18);
    }
  }

  if (amountRaw === "0" || BigInt(amountRaw) === 0n) {
    throw new Error(
      isSell
        ? "Resolved sell amount is 0. Try 'sell 50%' or 'sell all' to size off your on-chain balance."
        : "No trade amount specified. Use /mode to set a default amount, or say 'buy 0.01 ETH of [token]'.",
    );
  }

  // Diagnostics: useful in demos and post-mortems.
  console.log(
    `[execution] resolved ${intent.side} amount: raw=${amountRaw} unit=${intent.amount.unit} value=${intent.amount.value} type=${swapType} decimalsIn=${inputDecimals} decimalsOut=${outputDecimals}`,
  );

  // Step 1: Check approval (skipped for native ETH, required for ERC-20 input tokens)
  const MAX_UINT = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  if (tokenIn !== ETH_ADDRESS) {
    await checkAndSubmitApproval(
      tokenIn,
      isSell || hasFromToken ? MAX_UINT : amountRaw,
      swapperAddress,
      numChainId,
      apiKey,
      intent.userId,
    );
  }

  // Step 2: Get quote (chainId as string per Uniswap API spec)
  const slippage = Math.min(quote.expectedSlippagePct, MAX_SLIPPAGE_PCT);
  const quoteResp = await fetch(`${UNISWAP_API}/quote`, {
    method: "POST",
    headers: UNISWAP_HEADERS(apiKey),
    body: JSON.stringify({
      swapper: swapperAddress,
      tokenIn,
      tokenOut,
      tokenInChainId: String(numChainId),
      tokenOutChainId: String(numChainId),
      amount: amountRaw,
      type: swapType,
      slippageTolerance: parseFloat(slippage.toFixed(2)),
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
  const routingType = (quoteData["routing"] as string) ?? "CLASSIC";
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

  const executionPriceUsd = quote.priceUsd;
  let gasFeeUsd: number | null = null;
  try {
    if (routingType === "CLASSIC") {
      // CLASSIC: output.amount is the exact output, gasFeeUSD is gas estimate
      const qOutput = quoteData["output"] as { amount?: string } | undefined;
      const gasField = quoteData["gasFeeUSD"] as string | undefined;
      if (gasField) gasFeeUsd = parseFloat(gasField);
      if (qOutput?.amount) {
        console.log(
          `[execution] CLASSIC output=${qOutput.amount}${gasFeeUsd ? ` gas=$${gasFeeUsd.toFixed(2)}` : ""}`,
        );
      }
    } else {
      // UniswapX: orderInfo.outputs[0].startAmount
      const orderInfo = quoteData["orderInfo"] as
        | { outputs?: Array<{ startAmount?: string }> }
        | undefined;
      const startAmt = orderInfo?.outputs?.[0]?.startAmount;
      if (startAmt) {
        console.log(`[execution] ${routingType} orderInfo.outputs[0].startAmount=${startAmt}`);
      }
    }
  } catch {
    // Non-critical
  }

  return {
    txHash: result.hash,
    confirmedAt: Date.now(),
    filledAmount: intent.amount,
    actualPriceUsd: executionPriceUsd,
    mevProtected: khActive,
  };
}

async function executeSolanaSwap(intent: TradeIntent, quote: Quote): Promise<ExecutionReceipt> {
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
    console.error(
      `[execution] no context for ${intentId} — cached IDs: [${[...contextCache.keys()].map((k) => k.slice(0, 8)).join(", ")}]`,
    );
    bus.emit("QUOTE_FAILED", {
      intentId,
      address: "",
      reason: "Execution context lost. Try again.",
    });
    return;
  }

  const { intent, quote } = ctx;
  if (!quote) {
    console.error(`[execution] no quote for ${intentId}`);
    bus.emit("QUOTE_FAILED", {
      intentId,
      address: intent.address,
      reason: "Quote not received in time. Try again.",
    });
    return;
  }

  // Track which position to clean up after a successful sell
  let sellPositionId: string | null = null;
  if (intent.side === "sell") {
    const userPositions = getPositionsByUserInternal(intent.userId).filter(
      (p) => p.address.toLowerCase() === intent.address.toLowerCase(),
    );
    if (userPositions.length > 0) {
      sellPositionId = userPositions[0]!.positionId;
    }
    console.log(
      `[execution] sell swap for ${intent.address.slice(0, 10)}...${sellPositionId ? ` (position ${sellPositionId.slice(0, 8)})` : " (no tracked position)"}`,
    );
  }

  const swapDesc = intent.fromTokenAddress
    ? `${intent.fromTokenAddress.slice(0, 10)}→${intent.address.slice(0, 10)}`
    : `${intent.side} ${intent.address.slice(0, 10)}`;
  console.log(`[execution] ${intent.chain} ${swapDesc}... for user ${intent.userId}`);

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
    ...(quote.totalSupply ? { totalSupply: quote.totalSupply } : {}),
  };

  setPosition(position.positionId, position);
  bus.emit("TRADE_EXECUTED", position);
  contextCache.delete(intentId);

  recordTrade({
    intentId,
    userId: intent.userId,
    side: intent.side === "sell" ? "sell" : "buy",
    address: intent.address,
    chainId: quote.chainId,
    symbol: intent.symbol,
    filled: receipt.filledAmount,
    priceUsd: receipt.actualPriceUsd,
    txHash: receipt.txHash,
    mevProtected: receipt.mevProtected,
    timestamp: Date.now(),
  });

  if (sellPositionId) {
    deletePosition(sellPositionId);
    console.log(`[execution] cleaned up position ${sellPositionId.slice(0, 8)} after sell`);
  }

  console.log(`[execution] done tx=${receipt.txHash.slice(0, 16)}...`);
}

async function handleSell(payload: ExecuteSellPayload): Promise<void> {
  const position = getPosition(payload.positionId);
  if (!position) {
    console.warn(`[execution] sell: unknown position ${payload.positionId}`);
    return;
  }

  const pctOfBalance = Math.max(0, Math.min(100, payload.fraction * 100));
  console.log(`[execution] sell ${pctOfBalance}% of ${position.address.slice(0, 10)}...`);

  // Auto-sells size off the live on-chain balance via PERCENT — never against
  // the original buy-side ETH amount. executeEvmSwap will read the balance
  // and compute the exact token amount to swap (EXACT_INPUT).
  const sellIntent: TradeIntent = {
    intentId: randomUUID(),
    userId: position.userId,
    channel: "telegram",
    address: position.address,
    chain: position.address.startsWith("0x") ? "evm" : "solana",
    amount: { value: pctOfBalance, unit: "PERCENT" },
    exits: [],
    urgency: "NORMAL",
    rawText: `auto-sell ${pctOfBalance}%`,
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
    expectedSlippagePct: 2,
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

    recordTrade({
      intentId: sellIntent.intentId,
      userId: position.userId,
      side: "sell",
      address: position.address,
      chainId: position.chainId,
      symbol: position.symbol,
      filled: { value: position.filled.value * payload.fraction, unit: position.filled.unit },
      priceUsd: receipt.actualPriceUsd,
      txHash: receipt.txHash,
      mevProtected: receipt.mevProtected,
      timestamp: Date.now(),
    });

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
  loadTradeHistory();
  walletMgr = deps.walletManager ?? null;
  keeperHubClient = deps.keeperHub ?? null;

  if (!walletMgr) {
    console.warn("[execution] no wallet manager — trades will fail");
  }
  if (keeperHubClient) {
    console.log("[execution] KeeperHub active — checking connectivity...");
    keeperHubClient
      .checkReachable()
      .then((ok) => {
        if (ok)
          console.log("[execution] KeeperHub reachable — all mainnet swaps will be MEV-protected");
        else
          console.warn(
            "[execution] KeeperHub unreachable — mainnet swaps will proceed without MEV protection",
          );
      })
      .catch(() => {});
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

export { getPositionsByUser, getPosition } from "./position-store";
