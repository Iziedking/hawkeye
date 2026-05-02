// HAWKEYE terminal logger — zero dependencies, ANSI-only

// ---------------------------------------------------------------------------
// ANSI color codes
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  lightPink: "\x1b[95m",
  lightBrown: "\x1b[33m",
  deepPink: "\x1b[35m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  brightYellow: "\x1b[93m",
  white: "\x1b[97m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
} as const;

// ---------------------------------------------------------------------------
// Sponsor status (mutable at runtime, import and flip before ready())
// ---------------------------------------------------------------------------

export const sponsors = {
  og: { compute: false, storage: false, chain: false },
  gensyn: { connected: false, peers: 0 },
  uniswap: { active: false },
  keeper: { active: false },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function pad(tag: string, width: number = 12): string {
  return tag.length >= width ? tag.slice(0, width) : tag + " ".repeat(width - tag.length);
}

function line(tagColor: string, tag: string, msg: string): void {
  const timestamp = `${C.gray}${ts()}${C.reset}`;
  const label = `${tagColor}${pad(tag)}${C.reset}`;
  process.stdout.write(`${timestamp} ${label} ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Ready config
// ---------------------------------------------------------------------------

export type ReadyConfig = {
  ogCompute: boolean;
  ogStorage: boolean;
  ogChain: boolean;
  ogChainAddr?: string;
  gensyn: boolean;
  gensynPeers?: number;
  uniswap: boolean;
  keeperHub: boolean;
  privy: boolean;
  llmFallback: string | null;
  agentCount: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function statusText(on: boolean): string {
  return on ? `${C.green}[ON]${C.reset}` : `${C.red}[OFF]${C.reset}`;
}

function bannerLine(labelColor: string, label: string, on: boolean, detail: string): string {
  const padded = pad(label, 15);
  return `  ${labelColor}${padded}${C.reset}${statusText(on)}   ${C.gray}${detail}${C.reset}`;
}

export const log = {
  boot(msg: string): void {
    line(C.cyan, "BOOT", msg);
  },

  trade(side: string, addr: string, chain: string, timing?: string): void {
    const timePart = timing ? ` ${C.gray}${timing}${C.reset}` : "";
    line(C.cyan, "TRADE", `${side} ${addr} on ${chain}${timePart}`);
  },

  og(subsystem: "compute" | "storage" | "chain", msg: string): void {
    const tag = `0G:${subsystem}`;
    line(C.lightPink, tag, msg);
  },

  gensyn(msg: string): void {
    line(C.lightBrown, "GENSYN", msg);
  },

  uniswap(action: string, msg: string): void {
    line(C.deepPink, "UNISWAP", `${action} ${msg}`);
  },

  keeper(msg: string): void {
    line(C.green, "KEEPERHUB", msg);
  },

  agent(name: string, msg: string): void {
    line(C.cyan, `AGENT:${name}`, msg);
  },

  bus(event: string, msg: string): void {
    line(C.gray, "BUS", `${event} ${C.dim}${msg}${C.reset}`);
  },

  privy(msg: string): void {
    line(C.cyan, "PRIVY", msg);
  },

  warn(msg: string): void {
    line(C.brightYellow, "WARN", `${C.brightYellow}${msg}${C.reset}`);
  },

  error(msg: string, detail?: unknown): void {
    line(C.red, "ERROR", `${C.red}${msg}${C.reset}`);
    if (detail !== undefined) {
      const text =
        typeof detail === "string"
          ? detail
          : detail instanceof Error
            ? detail.stack ?? detail.message
            : JSON.stringify(detail, null, 2);
      for (const ln of text.split("\n")) {
        process.stdout.write(`${C.gray}         ${C.dim}${ln}${C.reset}\n`);
      }
    }
  },

  ready(cfg: ReadyConfig): void {
    const BAR = `${C.gray}═══════════════════════════════════════════${C.reset}`;
    const w = process.stdout.write.bind(process.stdout);

    w("\n");
    w(`${BAR}\n`);
    w(`  ${C.cyan}${C.bold}HAWKEYE v0.1${C.reset}  ${C.gray}Autonomous Trading Agent${C.reset}\n`);
    w(`${BAR}\n`);

    const chainDetail = cfg.ogChain && cfg.ogChainAddr
      ? `contract ${cfg.ogChainAddr.slice(0, 6)}...`
      : cfg.ogChain
        ? "contract deployed"
        : "not deployed";

    const gensynDetail = cfg.gensyn
      ? `${cfg.gensynPeers ?? 0} peers on AXL`
      : "local-only";

    w(bannerLine(C.lightPink, "0G Compute", cfg.ogCompute, cfg.ogCompute ? "qwen-2.5-7b" : "disabled") + "\n");
    w(bannerLine(C.lightPink, "0G Storage", cfg.ogStorage, cfg.ogStorage ? "testnet" : "disabled") + "\n");
    w(bannerLine(C.lightPink, "0G Chain", cfg.ogChain, chainDetail) + "\n");
    w(bannerLine(C.lightBrown, "Gensyn AXL", cfg.gensyn, gensynDetail) + "\n");
    w(bannerLine(C.deepPink, "Uniswap API", cfg.uniswap, cfg.uniswap ? "Trading API v1" : "disabled") + "\n");
    w(bannerLine(C.green, "KeeperHub", cfg.keeperHub, cfg.keeperHub ? "MEV protection" : "disabled") + "\n");
    w(bannerLine(C.cyan, "Privy Wallets", cfg.privy, cfg.privy ? "per-user wallets" : "disabled") + "\n");
    w(bannerLine(C.cyan, "LLM Fallback", cfg.llmFallback !== null, cfg.llmFallback ?? "disabled") + "\n");

    w(`${BAR}\n`);
    w(`  ${C.white}${C.bold}${cfg.agentCount} agents online${C.reset} ${C.gray}swarm ready${C.reset}\n`);
    w(`${BAR}\n`);
    w("\n");
  },
};
