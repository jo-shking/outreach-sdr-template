import "server-only";

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { companyIdFor } from "@/lib/sheet-writes";
import type { CompanyResearch } from "@/lib/company-research";

// Research costs roughly two cents of Exa plus an OpenRouter call per run, and the full
// summary and pitch are too long to keep in the spreadsheet. Caching them on disk means a
// company is researched once rather than once per click, and reopening an account shows
// the previous result immediately.
// A hosted deployment points RESEARCH_CACHE_DIR at a mounted volume so the cache
// survives restarts and redeploys; locally it defaults to the project directory.
const CACHE_DIR =
  process.env.RESEARCH_CACHE_DIR?.trim() ||
  path.join(process.cwd(), ".research-cache");
// Bump when the CompanyResearch shape changes, so stale envelopes are ignored rather than
// rendered with missing fields.
const CACHE_VERSION = 1;

export type CachedResearch = {
  companyName: string;
  cachedAt: string;
  research: CompanyResearch;
};

type Envelope = {
  version: number;
  companyName: string;
  cachedAt: string;
  research: unknown;
};

function cacheFile(companyName: string) {
  const key = companyIdFor(companyName);
  return key ? path.join(CACHE_DIR, `${key}.json`) : null;
}

/**
 * A cached payload is only as trustworthy as the file on disk, which may have been written
 * by an older version or edited by hand. Anything that does not look like a research
 * result is treated as a cache miss rather than rendered half-empty.
 */
function looksLikeResearch(value: unknown): value is CompanyResearch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const item = value as Record<string, unknown>;
  return (
    typeof item.companyName === "string" &&
    Array.isArray(item.sources) &&
    typeof item.fitScore === "number" &&
    typeof item.confidenceScore === "number" &&
    Array.isArray(item.claims) &&
    Array.isArray(item.limitations)
  );
}

export async function readCachedResearch(
  companyName: string,
): Promise<CachedResearch | null> {
  const file = cacheFile(companyName);
  if (!file) return null;

  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch {
    // A missing file is the normal case, not an error.
    return null;
  }

  try {
    const envelope = JSON.parse(raw) as Envelope;

    if (envelope.version !== CACHE_VERSION) return null;
    if (!looksLikeResearch(envelope.research)) return null;

    return {
      companyName: envelope.companyName,
      cachedAt: envelope.cachedAt,
      research: envelope.research,
    };
  } catch {
    console.error("Discarding an unreadable research cache entry", { companyName });
    return null;
  }
}

export async function writeCachedResearch(
  companyName: string,
  research: CompanyResearch,
): Promise<void> {
  const file = cacheFile(companyName);
  if (!file) return;

  const envelope: Envelope = {
    version: CACHE_VERSION,
    companyName,
    cachedAt: new Date().toISOString(),
    research,
  };

  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(envelope, null, 2), "utf8");
  } catch (error) {
    // Failing to cache must never fail the research request itself.
    console.error("Could not write the research cache", {
      companyName,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Company names that already have cached research, so the list can show which are done. */
export async function listCachedCompanies(): Promise<
  Array<{ companyName: string; cachedAt: string }>
> {
  try {
    const files = await readdir(CACHE_DIR);
    const entries = await Promise.all(
      files
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            const envelope = JSON.parse(
              await readFile(path.join(CACHE_DIR, name), "utf8"),
            ) as Envelope;
            return envelope.version === CACHE_VERSION &&
              typeof envelope.companyName === "string"
              ? { companyName: envelope.companyName, cachedAt: envelope.cachedAt }
              : null;
          } catch {
            return null;
          }
        }),
    );

    return entries.filter((entry): entry is { companyName: string; cachedAt: string } =>
      Boolean(entry),
    );
  } catch {
    return [];
  }
}

export type CachedSummary = {
  companyName: string;
  cachedAt: string;
  fitScore: number;
  confidenceScore: number;
  alignmentSummary: string | null;
  pitchAngle: string | null;
  sourceCount: number;
  personalized: boolean;
};

/**
 * Every company already researched, with the prose that was deliberately kept out of the
 * spreadsheet. This is what makes a "already done" view possible without spending another
 * Exa search or OpenRouter call.
 */
export async function listCachedResearch(): Promise<CachedSummary[]> {
  let files: string[];

  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return [];
  }

  const entries = await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const envelope = JSON.parse(
            await readFile(path.join(CACHE_DIR, name), "utf8"),
          ) as Envelope;

          if (envelope.version !== CACHE_VERSION) return null;
          if (!looksLikeResearch(envelope.research)) return null;

          const research = envelope.research;
          return {
            companyName: envelope.companyName,
            cachedAt: envelope.cachedAt,
            fitScore: research.fitScore,
            confidenceScore: research.confidenceScore,
            alignmentSummary: research.alignmentSummary,
            pitchAngle: research.pitchAngle,
            sourceCount: research.sources.length,
            // A sources-only result is worth re-running; a synthesised one is not.
            personalized: Boolean(research.alignmentSummary || research.companyOverview),
          };
        } catch {
          return null;
        }
      }),
  );

  return entries
    .filter((entry): entry is CachedSummary => Boolean(entry))
    .sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));
}
