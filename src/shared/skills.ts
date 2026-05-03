import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";

export type Skill = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  tags: string[];
  body: string;
};

export type AgentTag = "strategy" | "research" | "gateway" | "quote" | "router";

const SKILLS_DIR = resolve(process.cwd(), "src/skills/available");

const AGENT_TAG_FILTER: Record<AgentTag, Set<string>> = {
  strategy: new Set([
    "safety",
    "risk-management",
    "mev",
    "security",
    "sizing",
    "gas",
    "trading",
    "personality",
    "rug-detection",
    "frontrun",
    "sandwich",
  ]),
  research: new Set([
    "research",
    "analysis",
    "tokens",
    "whale",
    "smart-money",
    "narratives",
    "defi",
    "chains",
    "forensics",
    "smart-contract",
    "alpha",
    "memecoin",
    "rug-detection",
    "investigation",
    "onchain",
  ]),
  gateway: new Set(["personality", "safety", "security", "trading"]),
  quote: new Set(["mev", "gas", "optimization", "sniping", "entry"]),
  router: new Set(["personality"]),
};

let cached: Skill[] | null = null;

export function loadSkills(): Skill[] {
  if (cached) return cached;
  if (!existsSync(SKILLS_DIR)) {
    cached = [];
    return cached;
  }
  const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  const skills: Skill[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(resolve(SKILLS_DIR, file), "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;
      skills.push({
        id: basename(file, ".md"),
        name: typeof parsed.fm["name"] === "string" ? parsed.fm["name"] : file,
        description: typeof parsed.fm["description"] === "string" ? parsed.fm["description"] : "",
        enabled: parsed.fm["enabled"] === false ? false : true,
        priority: typeof parsed.fm["priority"] === "number" ? parsed.fm["priority"] : 50,
        tags: Array.isArray(parsed.fm["tags"]) ? (parsed.fm["tags"] as string[]) : [],
        body: parsed.body.trim(),
      });
    } catch (err) {
      console.warn(`[skills] failed to load ${file}: ${(err as Error).message}`);
    }
  }
  skills.sort((a, b) => b.priority - a.priority);
  cached = skills;
  return cached;
}

export function getSkillsForAgent(
  agentTag: AgentTag,
  userOverrides: Record<string, boolean> = {},
): Skill[] {
  const filter = AGENT_TAG_FILTER[agentTag];
  return loadSkills().filter((s) => {
    const enabled = userOverrides[s.id] ?? s.enabled;
    if (!enabled) return false;
    return s.tags.some((t) => filter.has(t));
  });
}

export function composeSkillsPrompt(
  agentTag: AgentTag,
  userOverrides: Record<string, boolean> = {},
): string {
  const skills = getSkillsForAgent(agentTag, userOverrides);
  if (skills.length === 0) return "";
  const sections = skills
    .map((s) => `## ${s.name} (priority ${s.priority})\n\n${s.body}`)
    .join("\n\n---\n\n");
  return [
    "",
    "# Active Behavior Skills",
    "",
    "The following skills shape your responses. Higher priority overrides lower when guidance conflicts.",
    "",
    sections,
    "",
    "# End Skills",
    "",
  ].join("\n");
}

export function listSkills(): Skill[] {
  return loadSkills();
}

export function reloadSkills(): Skill[] {
  cached = null;
  return loadSkills();
}

type Frontmatter = Record<string, string | number | boolean | string[]>;

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } | null {
  const normalized = raw.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  const closingIdx = normalized.indexOf("\n---", 3);
  if (closingIdx < 0) return null;
  const fmRaw = normalized.slice(3, closingIdx);
  const body = normalized.slice(closingIdx + 4);
  const fm: Frontmatter = {};
  for (const line of fmRaw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const valRaw = (m[2] ?? "").trim();
    fm[key] = parseScalar(valRaw);
  }
  return { fm, body };
}

function parseScalar(v: string): string | number | boolean | string[] {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);
  }
  return v;
}
