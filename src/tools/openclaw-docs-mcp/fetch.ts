import TurndownService from "turndown";
import { DEFAULT_ORIGIN, USER_AGENT, isAllowedUrl } from "./sources.js";

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  text: string;
  markdown: string;
  fromCache: boolean;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.remove(["script", "style", "noscript", "iframe"]);
turndown.addRule("strip-nav-footer", {
  filter: (node) => {
    const tag = node.nodeName.toLowerCase();
    if (tag === "nav" || tag === "footer" || tag === "header") return true;
    const cls = (node.getAttribute?.("class") ?? "").toLowerCase();
    return /(^|\s)(nav|footer|sidebar|menu|breadcrumb)(\s|$)/.test(cls);
  },
  replacement: () => "",
});

type CacheEntry = { at: number; result: FetchResult };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function resolveUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const origin = DEFAULT_ORIGIN.replace(/\/+$/, "");
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${origin}${path}`;
}

function isTextLike(url: string, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/plain") || ct.includes("text/markdown")) return true;
  if (ct.includes("application/json")) return true;
  const lower = url.toLowerCase();
  return (
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".json") ||
    lower.includes("/llms.txt") ||
    lower.includes("/llms-full.txt") ||
    lower.includes("raw.githubusercontent.com")
  );
}

export async function fetchDoc(
  pathOrUrl: string,
  opts: { bypassCache?: boolean } = {},
): Promise<FetchResult> {
  const url = resolveUrl(pathOrUrl);

  if (!isAllowedUrl(url)) {
    throw new FetchError(
      `URL is outside the allow-list. Only openclaws.io, openclaw.ai, and the openclaw GitHub raw origin are permitted.`,
      url,
    );
  }

  if (!opts.bypassCache) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.result, fromCache: true };
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FetchError(`Network error fetching ${url}: ${msg}`, url);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (!response.ok) {
    throw new FetchError(
      `HTTP ${response.status} fetching ${url}. First 200 chars of body: ${text.slice(0, 200)}`,
      url,
      response.status,
    );
  }

  const markdown = isTextLike(url, contentType) ? text : turndown.turndown(text);

  const result: FetchResult = {
    url,
    status: response.status,
    contentType,
    text,
    markdown: markdown.trim(),
    fromCache: false,
  };

  cache.set(url, { at: Date.now(), result });
  return result;
}

export function clearFetchCache(): void {
  cache.clear();
}
