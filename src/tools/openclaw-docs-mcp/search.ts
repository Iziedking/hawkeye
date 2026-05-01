import { fetchDoc } from "./fetch.js";
import { CURATED_INDEX, LLMS_FULL_URL, type CuratedEntry } from "./sources.js";

export interface SearchHit {
  source: "curated" | "llms-full";
  url: string;
  title: string;
  score: number;
  snippet: string;
  authoritative: boolean;
  tags?: string[];
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2);
}

function scoreCurated(entry: CuratedEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystackTitle = entry.title.toLowerCase();
  const haystackSummary = entry.summary.toLowerCase();
  const haystackTags = entry.tags.map((t) => t.toLowerCase());

  let score = 0;
  for (const tok of tokens) {
    if (haystackTitle.includes(tok)) score += 5;
    if (haystackTags.includes(tok)) score += 4;
    if (haystackSummary.includes(tok)) score += 2;
  }
  if (entry.authoritative && score > 0) score += 3;
  return score;
}

function searchCurated(query: string): SearchHit[] {
  const tokens = tokenize(query);
  const hits: SearchHit[] = [];
  for (const entry of CURATED_INDEX) {
    const score = scoreCurated(entry, tokens);
    if (score > 0) {
      hits.push({
        source: "curated",
        url: entry.url,
        title: entry.title,
        score,
        snippet: entry.summary,
        authoritative: entry.authoritative,
        tags: entry.tags,
      });
    }
  }
  return hits;
}

interface LlmsSection {
  heading: string;
  url: string | null;
  body: string;
}

function parseLlmsFull(text: string): LlmsSection[] {
  // llms-full.txt is a single markdown document with H1/H2 section headers.
  // Split on top-level headings and keep the heading + body together.
  const lines = text.split(/\r?\n/);
  const sections: LlmsSection[] = [];
  let current: LlmsSection | null = null;

  for (const line of lines) {
    const headingMatch = /^#{1,3}\s+(.*)$/.exec(line);
    if (headingMatch) {
      if (current && current.body.trim().length > 0) sections.push(current);
      const heading = (headingMatch[1] ?? "").trim();
      current = { heading, url: null, body: "" };
      continue;
    }
    if (!current) {
      current = { heading: "(preamble)", url: null, body: "" };
    }
    // Try to capture the first URL in the section body as a canonical link.
    if (!current.url) {
      const urlMatch = /https?:\/\/[^\s)]+/.exec(line);
      if (urlMatch) current.url = urlMatch[0];
    }
    current.body += line + "\n";
  }
  if (current && current.body.trim().length > 0) sections.push(current);
  return sections;
}

function scoreSection(section: LlmsSection, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const hay = (section.heading + "\n" + section.body).toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    // Count bounded occurrences; cheap but good enough for a docs corpus.
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const matches = hay.match(re);
    if (matches) score += matches.length;
  }
  // Boost if heading itself contains a token.
  const headingLower = section.heading.toLowerCase();
  for (const tok of tokens) if (headingLower.includes(tok)) score += 3;
  return score;
}

function buildSnippet(body: string, tokens: string[], maxLen = 320): string {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const tok of tokens) {
    const i = lower.indexOf(tok);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return body.slice(0, maxLen).trim();
  const start = Math.max(0, idx - 80);
  const end = Math.min(body.length, start + maxLen);
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "… " : "") + slice + (end < body.length ? " …" : "");
}

async function searchLlmsFull(query: string, limit: number): Promise<SearchHit[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  let corpus: string;
  try {
    const doc = await fetchDoc(LLMS_FULL_URL);
    corpus = doc.markdown || doc.text;
  } catch {
    // llms-full.txt failures are non-fatal; curated index still returns.
    return [];
  }

  const sections = parseLlmsFull(corpus);
  const scored = sections
    .map((s) => ({ s, score: scoreSection(s, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ s, score }) => ({
    source: "llms-full" as const,
    url: s.url ?? LLMS_FULL_URL,
    title: s.heading || "(untitled section)",
    score,
    snippet: buildSnippet(s.body, tokens),
    authoritative: false,
  }));
}

export async function searchDocs(
  query: string,
  opts: { limit?: number; includeLlmsFull?: boolean } = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const includeLlms = opts.includeLlmsFull ?? true;

  const curated = searchCurated(query);
  const llms = includeLlms ? await searchLlmsFull(query, limit) : [];

  const combined = [...curated, ...llms].sort((a, b) => {
    if (a.authoritative !== b.authoritative) return a.authoritative ? -1 : 1;
    return b.score - a.score;
  });

  // De-duplicate by URL, keep the higher-ranked entry.
  const seen = new Set<string>();
  const deduped: SearchHit[] = [];
  for (const hit of combined) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    deduped.push(hit);
    if (deduped.length >= limit) break;
  }
  return deduped;
}
