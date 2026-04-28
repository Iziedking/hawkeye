/**
 * Skill Loader
 *
 * Skills are markdown files in src/skills/available/ that modify agent behavior.
 * Each skill file has YAML front-matter with metadata and markdown body with instructions.
 *
 * Skills get injected into the system prompt so the LLM follows them.
 *
 * Structure of a skill file:
 * ---
 * name: "Degen Trader"
 * description: "Aggressive memecoin trading personality"
 * enabled: true
 * priority: 10
 * tags: ["trading", "memecoin"]
 * ---
 * # Degen Trader Skill
 * ... instructions ...
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillMeta {
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  tags: string[];
  filename: string;
}

export interface LoadedSkill extends SkillMeta {
  instructions: string;
}

// ---------------------------------------------------------------------------
// YAML front-matter parser (lightweight, no deps)
// ---------------------------------------------------------------------------

function parseFrontMatter(content: string): { meta: Record<string, unknown>; body: string } {
  const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(fmRegex);

  if (!match) {
    return { meta: {}, body: content };
  }

  const rawYaml = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};

  for (const line of rawYaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse simple types
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^\d+$/.test(value as string)) value = parseInt(value as string, 10);
    else if (/^\d+\.\d+$/.test(value as string)) value = parseFloat(value as string);
    else if ((value as string).startsWith("[") && (value as string).endsWith("]")) {
      // Simple array: ["a", "b", "c"]
      try {
        value = JSON.parse((value as string).replace(/'/g, '"'));
      } catch {
        // Leave as string
      }
    } else if ((value as string).startsWith('"') && (value as string).endsWith('"')) {
      value = (value as string).slice(1, -1);
    }

    meta[key] = value;
  }

  return { meta, body };
}

// ---------------------------------------------------------------------------
// Skill directory
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.resolve(__dirname, "available");

/**
 * Load all skill files from the skills/available directory.
 */
export function loadAllSkills(): LoadedSkill[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log(`[Skills] No skills directory at ${SKILLS_DIR} — creating it`);
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  const skills: LoadedSkill[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(SKILLS_DIR, file), "utf-8");
      const { meta, body } = parseFrontMatter(content);

      const skill: LoadedSkill = {
        name: (meta.name as string) ?? file.replace(".md", ""),
        description: (meta.description as string) ?? "",
        enabled: meta.enabled !== false, // Default true
        priority: (meta.priority as number) ?? 50,
        tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
        filename: file,
        instructions: body,
      };

      skills.push(skill);
    } catch (err) {
      console.error(`[Skills] Failed to load ${file}:`, err);
    }
  }

  // Sort by priority (higher = more important = injected first)
  skills.sort((a, b) => b.priority - a.priority);

  console.log(
    `[Skills] Loaded ${skills.length} skills: ${skills.map((s) => `${s.name}(${s.enabled ? "✓" : "✗"})`).join(", ")}`,
  );

  return skills;
}

/**
 * Get only enabled skills.
 */
export function getEnabledSkills(skills: LoadedSkill[]): LoadedSkill[] {
  return skills.filter((s) => s.enabled);
}

/**
 * Build a prompt section from enabled skills.
 * This gets appended to the system prompt.
 */
export function buildSkillPrompt(skills: LoadedSkill[]): string {
  const enabled = getEnabledSkills(skills);
  if (enabled.length === 0) return "";

  const sections = enabled.map(
    (s) =>
      `### Skill: ${s.name}\n${s.description ? `_${s.description}_\n` : ""}${s.instructions}`,
  );

  return (
    "\n\n## Active Skills\nThe following skills modify your behavior. Follow their instructions precisely.\n\n" +
    sections.join("\n\n---\n\n")
  );
}

/**
 * Toggle a skill on/off by filename.
 * Rewrites the front-matter in the file.
 */
export function toggleSkill(filename: string, enabled: boolean): boolean {
  const filepath = path.join(SKILLS_DIR, filename);
  if (!fs.existsSync(filepath)) return false;

  let content = fs.readFileSync(filepath, "utf-8");

  // Replace enabled: true/false in front-matter
  if (/^enabled:\s*(true|false)\s*$/m.test(content)) {
    content = content.replace(
      /^enabled:\s*(true|false)\s*$/m,
      `enabled: ${enabled}`,
    );
  } else {
    // Add enabled field after the first ---
    content = content.replace(/^---\s*\n/, `---\nenabled: ${enabled}\n`);
  }

  fs.writeFileSync(filepath, content, "utf-8");
  return true;
}

/**
 * List skills as a formatted string for Telegram.
 */
export function formatSkillList(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return "No skills installed. Add .md files to src/skills/available/";
  }

  return skills
    .map(
      (s, i) =>
        `${i + 1}. ${s.enabled ? "✅" : "⬜"} *${s.name}* (p:${s.priority})\n   _${s.description || "No description"}_`,
    )
    .join("\n");
}
