import "server-only";

import {
  researchCompany,
  ResearchConfigurationError,
  ResearchProviderError,
} from "@/lib/company-research";
import {
  readCachedResearch,
  writeCachedResearch,
} from "@/lib/research-cache";

const MAX_NAME_LENGTH = 200;
const MAX_WEBSITE_LENGTH = 500;
const MAX_NOTES_LENGTH = 3_000;
const MAX_MISA_CONTEXT_LENGTH = 5_000;

function optionalString(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "The request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "A company is required." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const companyName = optionalString(input.companyName, MAX_NAME_LENGTH);

  if (!companyName) {
    return Response.json(
      { error: "The company name is required." },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  // A repeat click should cost nothing. `refresh: true` forces a fresh run when the
  // cached result looks stale or the synthesis failed last time.
  const refresh = input.refresh === true;

  if (!refresh) {
    const cached = await readCachedResearch(companyName);

    if (cached) {
      return Response.json(
        {
          research: cached.research,
          cachedAt: cached.cachedAt,
          fromCache: true,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  try {
    const research = await researchCompany({
      companyId: optionalString(input.companyId, 200),
      companyName,
      website: optionalString(input.website, MAX_WEBSITE_LENGTH),
      existingNotes: optionalString(input.existingNotes, MAX_NOTES_LENGTH),
      misaEvents: optionalString(input.misaEvents, MAX_MISA_CONTEXT_LENGTH),
      partnershipFormats: optionalString(
        input.partnershipFormats,
        MAX_MISA_CONTEXT_LENGTH,
      ),
    });

    // Cache even a sources-only result: it still cost an Exa search, and the limitation
    // text explains why synthesis failed. Refresh re-runs it when you want another try.
    await writeCachedResearch(companyName, research);

    return Response.json(
      { research, cachedAt: null, fromCache: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ResearchConfigurationError) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (error instanceof ResearchProviderError) {
      console.error("Company research provider failure", {
        provider: error.provider,
        failure: error.failure,
        upstreamStatus: error.status ?? null,
        companyName,
        durationMs: Date.now() - startedAt,
      });

      return Response.json(
        {
          error: error.message,
          provider: error.provider,
          failure: error.failure,
          upstreamStatus: error.status,
        },
        { status: error.failure === "timeout" ? 504 : 502 },
      );
    }

    console.error("Unexpected company research failure", {
      companyName,
      durationMs: Date.now() - startedAt,
    });

    return Response.json(
      { error: "The company research request failed safely." },
      { status: 500 },
    );
  }
}
