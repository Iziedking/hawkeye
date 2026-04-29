export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 " +
  "hawkeye-openclaw-docs-mcp/0.1";

export const ALLOWED_ORIGIN_PREFIXES = [
  "https://openclaws.io/",
  "https://raw.githubusercontent.com/openclaw/openclaw/",
  "https://openclaw.ai/",
] as const;

export const DEFAULT_ORIGIN = "https://openclaws.io" as const;

export const LLMS_FULL_URL = "https://openclaws.io/llms-full.txt" as const;
export const LLMS_INDEX_URL = "https://openclaws.io/llms.txt" as const;

export interface CuratedEntry {
  url: string;
  title: string;
  summary: string;
  tags: string[];
  authoritative: boolean;
}

export const CURATED_INDEX: CuratedEntry[] = [
  {
    url: "https://raw.githubusercontent.com/openclaw/openclaw/main/README.md",
    title: "Official OpenClaw README (GitHub)",
    summary: "Canonical project overview: install, architecture, supported channels, gateway port.",
    tags: ["readme", "official", "github", "canonical", "overview"],
    authoritative: true,
  },
  {
    url: "https://openclaws.io/install",
    title: "Install OpenClaw",
    summary:
      "Quick install commands for Windows, macOS, Linux; npm/pnpm; Docker; build from source.",
    tags: ["install", "setup", "getting-started"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/",
    title: "Docs — top-level index",
    summary: "Landing page for the docs section on the community mirror.",
    tags: ["docs", "index"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/install/",
    title: "Install docs",
    summary: "Detailed install guide across OSes, Docker, package managers.",
    tags: ["install", "setup"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/install/node/",
    title: "Node.js prerequisites",
    summary: "Node 22.16+ required; Node 24 recommended and default.",
    tags: ["install", "node", "runtime", "prerequisites"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/install/updating",
    title: "Updating OpenClaw",
    summary: "Upgrade and version-pinning commands.",
    tags: ["update", "upgrade"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/install/hetzner",
    title: "Hetzner VPS setup",
    summary: "Deploying OpenClaw on a Hetzner VPS via Docker.",
    tags: ["deploy", "vps", "docker", "hetzner"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/platforms/macos",
    title: "macOS companion app",
    summary: "Menu-bar companion app: permissions, gateway attach, macOS-specific capabilities.",
    tags: ["macos", "desktop", "companion-app"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/cli",
    title: "CLI reference",
    summary: "Full CLI command reference: onboard, gateway, doctor, status, install-daemon.",
    tags: ["cli", "commands", "reference"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/gateway/configuration",
    title: "Gateway configuration",
    summary: "JSON5 config at ~/.openclaw/openclaw.json; safe defaults; channels; models.",
    tags: ["gateway", "config", "configuration", "json5"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/docs/tools/web",
    title: "Web tools",
    summary: "Browser automation tools the gateway exposes to agents.",
    tags: ["tools", "web", "browser", "automation"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/integrations",
    title: "Integrations",
    summary:
      "Chat platforms (WhatsApp, Telegram via grammY, Discord, Slack via Bolt, Signal, iMessage, Teams, Matrix, WebChat), AI models, dev tools.",
    tags: [
      "integrations",
      "channels",
      "telegram",
      "whatsapp",
      "discord",
      "slack",
      "signal",
      "imessage",
      "models",
    ],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/faq",
    title: "FAQ",
    summary: "Frequently asked questions.",
    tags: ["faq"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/blog/openclaw-docker-deployment",
    title: "Running OpenClaw in Docker",
    summary: "Step-by-step Docker deployment with container-isolation security model.",
    tags: ["docker", "deploy", "security", "isolation"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/blog/openclaw-soul-md-guide",
    title: "SOUL.md guide",
    summary: "Writing the SOUL.md identity file that shapes agent personality.",
    tags: ["config", "soul", "personality", "identity"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/blog/openclaw-101-beginners-guide",
    title: "OpenClaw 101 — Beginners Guide",
    summary: "Gentle introduction; reasonable starting point for new users.",
    tags: ["beginner", "intro", "tutorial"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/blog/openclaw-contextengine-deep-dive",
    title: "ContextEngine deep dive",
    summary: "How OpenClaw manages context windows and memory.",
    tags: ["context", "memory", "internals"],
    authoritative: false,
  },
  {
    url: "https://openclaws.io/blog/openclaw-feishu-integration",
    title: "Feishu integration",
    summary: "Connecting OpenClaw to Feishu/Lark.",
    tags: ["channels", "feishu", "lark"],
    authoritative: false,
  },
];

export function isAllowedUrl(url: string): boolean {
  return ALLOWED_ORIGIN_PREFIXES.some((p) => url.startsWith(p));
}
