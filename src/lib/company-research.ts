import "server-only";

import {
  acceptsNativeSearchSynthesis,
  extractWebSearchCitations,
  hasUsableSynthesis,
  normalizeSourceReferences,
  parseResearchObject,
} from "@/lib/research-synthesis";

type ResearchInput = {
  companyId: string | null;
  companyName: string;
  website: string | null;
  existingNotes: string | null;
  misaEvents: string | null;
  partnershipFormats: string | null;
};

type ExaResult = {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  highlights?: string[] | null;
};

type ExaResponse = {
  results?: ExaResult[];
};

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      annotations?: unknown;
    };
  }>;
};

type Source = {
  id: string;
  title: string | null;
  url: string;
  publishedDate: string | null;
  evidence: string | null;
  isOfficial: boolean;
  searchProvider: "Exa" | "OpenRouter native search";
};

type Claim = {
  claim: string;
  evidence: string;
  sourceIds: string[];
};

type CommonRole = {
  role: string;
  evidence: string;
  sourceIds: string[];
};

type PartnershipOpportunity = {
  title: string;
  rationale: string;
  sourceIds: string[];
};

export type CompanyResearch = {
  companyId: string | null;
  companyName: string;
  companyOverview: string | null;
  companyOverviewSourceIds: string[];
  commonRoles: CommonRole[];
  alignmentSummary: string | null;
  alignmentSourceIds: string[];
  pitchAngle: string | null;
  pitchSourceIds: string[];
  partnershipOpportunities: PartnershipOpportunity[];
  fitScore: number;
  confidenceScore: number;
  confidenceBasis: string;
  claims: Claim[];
  limitations: string[];
  sources: Source[];
};

export class ResearchConfigurationError extends Error {}
export type ResearchProviderFailure =
  | "timeout"
  | "network"
  | "rejected"
  | "invalid_response"
  | "no_results";

export class ResearchProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: "Exa" | "OpenRouter",
    public readonly failure: ResearchProviderFailure,
    public readonly status?: number,
  ) {
    super(message);
  }
}

const MAX_SOURCES = 8;
const MAX_EVIDENCE_LENGTH = 1_500;
// Gemini native search returns opaque Vertex grounding-redirect URLs that the model
// cannot echo back as citations, so its results are never verifiably cited. This must
// stay a model whose native search returns real publisher URLs.
const DEFAULT_NATIVE_SEARCH_MODEL = "openai/gpt-5.2";
const MAX_NATIVE_SEARCH_TOOL_CALLS = 3;

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new ResearchConfigurationError(
      `${name} is not configured on the server.`,
    );
  }

  return value;
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function hostname(value: string | null) {
  if (!value) return null;

  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function text(value: unknown, maxLength = 2_000) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function score(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

function sourceIds(value: unknown, sources: Source[]) {
  return normalizeSourceReferences(value, sources).slice(0, MAX_SOURCES);
}

function buildSources(results: ExaResult[], website: string | null): Source[] {
  const officialHostname = hostname(website);
  const seenUrls = new Set<string>();

  return results.flatMap((result): Source[] => {
    if (!validHttpUrl(result.url) || seenUrls.has(result.url)) return [];
    seenUrls.add(result.url);

    const sourceHostname = hostname(result.url);
    const evidence =
      result.highlights
        ?.filter((highlight): highlight is string => typeof highlight === "string")
        .join("\n\n")
        .trim()
        .slice(0, MAX_EVIDENCE_LENGTH) || null;

    return [
      {
        id: `S${seenUrls.size}`,
        title: text(result.title, 500),
        url: result.url,
        publishedDate: text(result.publishedDate, 100),
        evidence,
        searchProvider: "Exa",
        isOfficial: Boolean(
          officialHostname &&
            sourceHostname &&
            (sourceHostname === officialHostname ||
              sourceHostname.endsWith(`.${officialHostname}`)),
        ),
      },
    ];
  }).slice(0, MAX_SOURCES);
}

function buildNativeSearchSources({
  message,
  website,
  startingIndex,
  excludeUrls,
}: {
  message: unknown;
  website: string | null;
  startingIndex: number;
  excludeUrls: readonly string[];
}): Source[] {
  const officialHostname = hostname(website);

  return extractWebSearchCitations(message, excludeUrls)
    .slice(0, MAX_SOURCES)
    .map((citation, index): Source => {
      const sourceHostname = hostname(citation.url);

      return {
        id: `S${startingIndex + index}`,
        title: citation.title,
        url: citation.url,
        publishedDate: null,
        evidence: citation.evidence,
        searchProvider: "OpenRouter native search",
        isOfficial: Boolean(
          officialHostname &&
            sourceHostname &&
            (sourceHostname === officialHostname ||
              sourceHostname.endsWith(`.${officialHostname}`)),
        ),
      };
    });
}

function evidenceConfidence(
  claims: Claim[],
  evidenceItems: Array<{ sourceIds: string[] }>,
  sources: Source[],
) {
  const uniqueCited = new Set([
    ...evidenceItems.flatMap((item) => item.sourceIds),
    ...claims.flatMap((claim) => claim.sourceIds),
  ]);
  const citedSources = sources.filter((source) => uniqueCited.has(source.id));
  const sourceCoverage = Math.min(uniqueCited.size, 4) * 10;
  const supportedItemCount = claims.length + evidenceItems.length;
  const claimCoverage = Math.min(supportedItemCount, 4) * 7.5;
  const officialEvidence = citedSources.some((source) => source.isOfficial) ? 15 : 0;
  const recentEvidence = citedSources.some((source) => {
    if (!source.publishedDate) return false;
    const published = Date.parse(source.publishedDate);
    return Number.isFinite(published) && Date.now() - published <= 3 * 365.25 * 86_400_000;
  })
    ? 15
    : 0;
  const confidence = Math.round(
    Math.min(100, sourceCoverage + claimCoverage + officialEvidence + recentEvidence),
  );

  return {
    confidence,
    basis: `${sources.length} source${sources.length === 1 ? "" : "s"} found; ${uniqueCited.size} cited, ${supportedItemCount} supported research item${supportedItemCount === 1 ? "" : "s"}, ${officialEvidence ? "official-source evidence" : "no official source cited"}, and ${recentEvidence ? "recent dated evidence" : "no recent dated source"}.`,
  };
}

async function requestOpenRouterSynthesis({
  apiKey,
  model,
  userPrompt,
}: {
  apiKey: string;
  model: string;
  userPrompt: string;
}): Promise<Record<string, unknown>> {
  let response: Response;

  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 6_000,
        messages: [
          {
            role: "system",
            content:
              "You are a cautious sponsorship research analyst. Use only the supplied sources for claims about the company. Never invent an email, employee, alumni relationship, MISA relationship, SFU relationship, donation, program, hiring pattern, or company fact. Treat existing notes and MISA planning context as user-provided context, not independent evidence about the company. Use MISA context to tailor recommendations, but cite source IDs that support the company side of every recommendation. Do not default to suggesting a speaker: consider all supplied events and partnership formats. Cite only supplied source IDs. If evidence is weak, return null fields, a low fit score, and explicit limitations. Fit measures alignment; it must not influence evidence confidence, which the server calculates separately.",
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(75_000),
    });
  } catch (error) {
    throw new ResearchProviderError(
      isTimeoutError(error)
        ? "OpenRouter took longer than 75 seconds."
        : "The server could not reach OpenRouter.",
      "OpenRouter",
      isTimeoutError(error) ? "timeout" : "network",
    );
  }

  if (!response.ok) {
    throw new ResearchProviderError(
      "OpenRouter rejected the research synthesis request.",
      "OpenRouter",
      "rejected",
      response.status,
    );
  }

  let data: OpenRouterResponse;

  try {
    data = (await response.json()) as OpenRouterResponse;
  } catch (error) {
    console.error("OpenRouter synthesis response was unreadable", {
      status: response.status,
      reason: error instanceof Error ? error.message : String(error),
    });

    throw new ResearchProviderError(
      isTimeoutError(error)
        ? "OpenRouter took longer than 75 seconds."
        : "OpenRouter returned an invalid response.",
      "OpenRouter",
      isTimeoutError(error) ? "timeout" : "invalid_response",
    );
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new ResearchProviderError(
      "OpenRouter returned no research synthesis.",
      "OpenRouter",
      "invalid_response",
    );
  }

  const parsed = parseResearchObject(content);

  if (!parsed) {
    console.error("OpenRouter synthesis content was not a JSON object", {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      contentPrefix: content.slice(0, 200),
    });

    throw new ResearchProviderError(
      "OpenRouter returned research in an unreadable format.",
      "OpenRouter",
      "invalid_response",
    );
  }

  return parsed;
}

async function requestNativeWebSearchSynthesis({
  apiKey,
  model,
  userPrompt,
}: {
  apiKey: string;
  model: string;
  userPrompt: string;
}): Promise<{ parsed: Record<string, unknown>; message: unknown }> {
  let response: Response;

  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 6_000,
        max_tool_calls: MAX_NATIVE_SEARCH_TOOL_CALLS,
        tools: [
          {
            type: "openrouter:web_search",
            parameters: {
              engine: "native",
              max_total_results: MAX_SOURCES,
              user_location: {
                type: "approximate",
                region: "British Columbia",
                country: "CA",
                timezone: "America/Vancouver",
              },
            },
          },
        ],
        messages: [
          {
            role: "system",
            content:
              "You are a cautious sponsorship research analyst with a web-search tool. Search before answering and use only pages the tool returned to you as evidence about the company. Never invent an email, employee, alumni relationship, MISA relationship, SFU relationship, donation, program, hiring pattern, or company fact. Treat existing notes and MISA planning context as user-provided context, not independent evidence about the company. Use MISA context to tailor recommendations, but cite retrieved URLs that support the company side of every recommendation. Do not default to suggesting a speaker: consider all supplied events and partnership formats. If the search results do not support a field, return null or omit the item rather than answering from your own knowledge. If evidence is weak, return null fields, a low fit score, and explicit limitations. Fit measures alignment; it must not influence evidence confidence, which the server calculates separately.",
          },
          { role: "user", content: userPrompt },
        ],
      }),
      cache: "no-store",
      // Live searches run before the model answers, so this needs more headroom than
      // the plain synthesis call.
      signal: AbortSignal.timeout(110_000),
    });
  } catch (error) {
    // Transport-level detail only; never the key or request body.
    console.error("OpenRouter native web-search transport failure", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      cause:
        error instanceof Error && error.cause instanceof Error
          ? `${error.cause.name}: ${error.cause.message}`
          : null,
    });

    throw new ResearchProviderError(
      isTimeoutError(error)
        ? "OpenRouter native web search took longer than 110 seconds."
        : "The server could not reach OpenRouter for native web search.",
      "OpenRouter",
      isTimeoutError(error) ? "timeout" : "network",
    );
  }

  if (!response.ok) {
    // OpenRouter states the reason in the body (unsupported tool, quota, bad model).
    // It echoes no credentials, so a truncated copy is safe to log.
    console.error("OpenRouter rejected the native web-search request", {
      status: response.status,
      body: (await response.text().catch(() => "")).slice(0, 500),
    });

    throw new ResearchProviderError(
      "OpenRouter rejected the native web-search request.",
      "OpenRouter",
      "rejected",
      response.status,
    );
  }

  let data: OpenRouterResponse;

  try {
    data = (await response.json()) as OpenRouterResponse;
  } catch (error) {
    throw new ResearchProviderError(
      isTimeoutError(error)
        ? "OpenRouter native web search took longer than 110 seconds."
        : "OpenRouter returned an invalid native web-search response.",
      "OpenRouter",
      isTimeoutError(error) ? "timeout" : "invalid_response",
    );
  }

  const message = data.choices?.[0]?.message;
  const content = message?.content;

  if (!content) {
    throw new ResearchProviderError(
      "OpenRouter native web search returned no research synthesis.",
      "OpenRouter",
      "invalid_response",
    );
  }

  const parsed = parseResearchObject(content);

  if (!parsed) {
    // finish_reason "length" means the object was truncated by the token cap rather
    // than merely wrapped in prose.
    console.error("OpenRouter native web-search content was not a JSON object", {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      contentLength: content.length,
      contentPrefix: content.slice(0, 200),
    });

    throw new ResearchProviderError(
      "OpenRouter native web search returned research in an unreadable format.",
      "OpenRouter",
      "invalid_response",
    );
  }

  return { parsed, message };
}

function sourcesOnlyResearch({
  input,
  sources,
  reason,
}: {
  input: ResearchInput;
  sources: Source[];
  reason: string;
}): CompanyResearch {
  return {
    companyId: input.companyId,
    companyName: input.companyName,
    companyOverview: null,
    companyOverviewSourceIds: [],
    commonRoles: [],
    alignmentSummary: null,
    alignmentSourceIds: [],
    pitchAngle: null,
    pitchSourceIds: [],
    partnershipOpportunities: [],
    fitScore: 0,
    confidenceScore: 0,
    confidenceBasis: `${sources.length} source${sources.length === 1 ? "" : "s"} found; OpenRouter produced no usable source-cited synthesis.`,
    claims: [],
    limitations: [
      `${reason} The source links are preserved below. Run Research again to retry synthesis.`,
    ],
    sources,
  };
}

const RESEARCH_FIELD_SPEC = [
  "- companyOverview: plain-language string explaining what the company does, or null",
  "- companyOverviewSourceIds: array of source references",
  "- commonRoles: array of objects with role, evidence, and sourceIds; include only job families or roles supported by the sources",
  "- alignmentSummary: string or null; explain the evidence-backed connection to MISA's audience and objectives",
  "- alignmentSourceIds: array of source references",
  "- partnershipOpportunities: array of up to 4 objects with title, rationale, and sourceIds; tailor these to the supplied MISA context and diversify beyond speaking when supported",
  "- pitchAngle: string or null; provide the strongest concise outreach angle",
  "- pitchSourceIds: array of source references",
  "- fitScore: integer from 0 to 100 based on demonstrated youth/education/community alignment, Canadian relevance, partnership plausibility, and verified SFU/MISA connection",
  "- claims: array of objects with claim, evidence, and sourceIds",
  "- limitations: array of strings",
].join("\n");

const EXA_CITATION_RULE = [
  "Every company overview, role, alignment, opportunity, pitch, and claim must be directly supported on the company side by at least one supplied source ID.",
  "Do not include URLs; use source IDs only.",
  "Every non-null research item must cite one or more IDs exactly as S1, S2, and so on.",
  "Do not return an entirely empty object when the sources support a basic company overview.",
  "Do not describe a role as commonly hired merely because one employee holds it.",
].join(" ");

const NATIVE_CITATION_RULE = [
  "Search the web before answering.",
  "Every sourceIds array must contain exact, complete URLs of pages the web-search tool returned to you in this conversation.",
  "Never cite a URL the search tool did not return, and never cite a page you did not retrieve.",
  "If the retrieved pages do not support a field, return null for it or omit the item rather than answering from your own knowledge.",
  "Do not describe a role as commonly hired merely because one employee holds it.",
].join(" ");

// Both synthesis paths share one field spec so the JSON shape cannot drift between them.
// Only the citation rule differs: supplied source IDs for Exa, retrieved URLs for native search.
function buildResearchPrompt({
  input,
  citationRule,
  sourcePacket,
}: {
  input: ResearchInput;
  citationRule: string;
  sourcePacket: string | null;
}) {
  const notes = input.existingNotes?.slice(0, 3_000) || "None provided";
  const misaEvents = input.misaEvents?.slice(0, 5_000) || "None provided";
  const partnershipFormats =
    input.partnershipFormats?.slice(0, 5_000) || "None provided";

  return [
    `Research target: ${input.companyName}`,
    `Website: ${input.website ?? "Unknown"}`,
    `Existing notes (unverified): ${notes}`,
    "",
    "MISA events and audiences (planning context, not company evidence):",
    misaEvents,
    "",
    "Partnership formats MISA can offer (planning context, not company evidence):",
    partnershipFormats,
    "",
    "Return one JSON object with exactly these fields:",
    RESEARCH_FIELD_SPEC,
    "",
    citationRule,
    ...(sourcePacket ? ["", `Sources:\n${sourcePacket}`] : []),
  ].join("\n");
}

export async function researchCompany(input: ResearchInput): Promise<CompanyResearch> {
  const exaApiKey = requiredEnvironment("EXA_API_KEY");
  const openRouterApiKey = requiredEnvironment("OPENROUTER_API_KEY");
  const model = requiredEnvironment("OPENROUTER_MODEL");
  const query = [
    `Research ${input.companyName}`,
    input.website ? `(${input.website})` : "",
    "Build a factual company profile for partnership research in Canada.",
    "Find what the company does, its products or services, job families or roles it commonly recruits for, education or youth initiatives, community impact, sponsorships, partnerships, leadership priorities, Canadian presence, and any verified SFU or MISA relationship.",
    "Do not infer an alumni relationship or unsupported commitment.",
  ]
    .filter(Boolean)
    .join(" ");

  let exaResponse: Response;

  try {
    exaResponse = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": exaApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        type: "deep-lite",
        numResults: MAX_SOURCES,
        additionalQueries: [
          `${input.companyName} official company overview products services Canada`,
          `${input.companyName} careers jobs roles hiring`,
          `${input.companyName} community education youth partnerships sponsorship Canada`,
        ],
        userLocation: "CA",
        moderation: true,
        contents: { highlights: true },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new ResearchProviderError(
      isTimeoutError(error)
        ? "Exa took longer than 45 seconds. Please try again."
        : "The server could not reach Exa.",
      "Exa",
      isTimeoutError(error) ? "timeout" : "network",
    );
  }

  if (!exaResponse.ok) {
    throw new ResearchProviderError(
      "Exa rejected the company research request.",
      "Exa",
      "rejected",
      exaResponse.status,
    );
  }

  let exaData: ExaResponse;

  try {
    exaData = (await exaResponse.json()) as ExaResponse;
  } catch (error) {
    throw new ResearchProviderError(
      isTimeoutError(error)
        ? "Exa took longer than 45 seconds. Please try again."
        : "Exa returned an invalid response.",
      "Exa",
      isTimeoutError(error) ? "timeout" : "invalid_response",
    );
  }
  const sources = buildSources(exaData.results ?? [], input.website);

  if (sources.length === 0) {
    throw new ResearchProviderError(
      "Exa returned no usable sources for this company.",
      "Exa",
      "no_results",
    );
  }

  const sourcePacket = sources
    .map(
      (source) =>
        `${source.id}\nTitle: ${source.title ?? "Unknown"}\nURL: ${source.url}\nPublished: ${source.publishedDate ?? "Unknown"}\nOfficial company domain: ${source.isOfficial ? "Yes" : "No"}\nEvidence:\n${source.evidence ?? "No excerpt available"}`,
    )
    .join("\n\n---\n\n");
  const userPrompt = buildResearchPrompt({
    input,
    citationRule: EXA_CITATION_RULE,
    sourcePacket,
  });
  let parsed: Record<string, unknown> | null = null;
  let allSources = sources;
  let synthesisFailure = "OpenRouter returned no source-cited research.";

  try {
    const candidate = await requestOpenRouterSynthesis({
      apiKey: openRouterApiKey,
      model,
      userPrompt,
    });

    if (hasUsableSynthesis(candidate, sources)) {
      parsed = candidate;
    } else {
      synthesisFailure =
        "OpenRouter returned a valid response but cited none of the available sources.";
    }
  } catch (error) {
    if (!(error instanceof ResearchProviderError)) throw error;

    // An auth or quota rejection would fail the fallback too, so surface it directly
    // instead of spending another paid call on it.
    if (error.failure === "rejected") throw error;
    synthesisFailure = error.message;
  }

  // Independent evidence path. Rather than re-prompting the model that just failed to
  // cite, let OpenRouter run its own web search and synthesize from pages it retrieved.
  if (!parsed) {
    const nativeSearchModel =
      process.env.OPENROUTER_NATIVE_SEARCH_MODEL?.trim() ||
      DEFAULT_NATIVE_SEARCH_MODEL;

    try {
      const native = await requestNativeWebSearchSynthesis({
        apiKey: openRouterApiKey,
        model: nativeSearchModel,
        userPrompt: buildResearchPrompt({
          input,
          citationRule: NATIVE_CITATION_RULE,
          sourcePacket: null,
        }),
      });
      const nativeSources = buildNativeSearchSources({
        message: native.message,
        website: input.website,
        startingIndex: sources.length + 1,
        excludeUrls: sources.map((source) => source.url),
      });
      const combinedSources = [...sources, ...nativeSources];

      if (acceptsNativeSearchSynthesis(native.parsed, nativeSources, combinedSources)) {
        parsed = native.parsed;
        allSources = combinedSources;
      } else {
        synthesisFailure = `${synthesisFailure} The native web-search fallback ${nativeSources.length === 0 ? "returned no citable sources" : "cited none of the pages it retrieved"}.`;
      }
    } catch (error) {
      if (!(error instanceof ResearchProviderError)) throw error;

      synthesisFailure = `${synthesisFailure} The native web-search fallback also failed: ${error.message}`;
    }
  }

  if (!parsed) {
    return sourcesOnlyResearch({ input, sources, reason: synthesisFailure });
  }

  const companyOverviewSourceIds = sourceIds(
    parsed.companyOverviewSourceIds,
    allSources,
  );
  const alignmentSourceIds = sourceIds(parsed.alignmentSourceIds, allSources);
  const pitchSourceIds = sourceIds(parsed.pitchSourceIds, allSources);
  const alignmentText = text(parsed.alignmentSummary, 2_500);
  const pitchText = text(parsed.pitchAngle, 2_500);
  const companyOverviewText = text(parsed.companyOverview, 2_500);
  const commonRoles = (Array.isArray(parsed.commonRoles) ? parsed.commonRoles : [])
    .flatMap((value) => {
      const item = record(value);
      if (!item) return [];
      const role = text(item.role, 500);
      const evidence = text(item.evidence, 1_500);
      const ids = sourceIds(item.sourceIds, allSources);
      return role && evidence && ids.length ? [{ role, evidence, sourceIds: ids }] : [];
    })
    .slice(0, 8);
  const partnershipOpportunities = (
    Array.isArray(parsed.partnershipOpportunities)
      ? parsed.partnershipOpportunities
      : []
  )
    .flatMap((value) => {
      const item = record(value);
      if (!item) return [];
      const title = text(item.title, 500);
      const rationale = text(item.rationale, 2_000);
      const ids = sourceIds(item.sourceIds, allSources);
      return title && rationale && ids.length
        ? [{ title, rationale, sourceIds: ids }]
        : [];
    })
    .slice(0, 4);
  const claims = (Array.isArray(parsed.claims) ? parsed.claims : [])
    .flatMap((value) => {
      const item = record(value);
      if (!item) return [];
      const claim = text(item.claim, 1_000);
      const evidence = text(item.evidence, 2_000);
      const ids = sourceIds(item.sourceIds, allSources);
      return claim && evidence && ids.length ? [{ claim, evidence, sourceIds: ids }] : [];
    })
    .slice(0, 8);
  const limitations = (Array.isArray(parsed.limitations) ? parsed.limitations : [])
    .flatMap((value) => {
      const limitation = text(value, 1_000);
      return limitation ? [limitation] : [];
    })
    .slice(0, 8);
  const evidenceItems = [
    ...(companyOverviewText && companyOverviewSourceIds.length
      ? [{ sourceIds: companyOverviewSourceIds }]
      : []),
    ...(alignmentText && alignmentSourceIds.length
      ? [{ sourceIds: alignmentSourceIds }]
      : []),
    ...(pitchText && pitchSourceIds.length
      ? [{ sourceIds: pitchSourceIds }]
      : []),
    ...commonRoles,
    ...partnershipOpportunities,
  ].filter((item) => item.sourceIds.length > 0);
  const confidence = evidenceConfidence(claims, evidenceItems, allSources);

  return {
    companyId: input.companyId,
    companyName: input.companyName,
    companyOverview:
      companyOverviewText && companyOverviewSourceIds.length
        ? companyOverviewText
        : null,
    companyOverviewSourceIds,
    commonRoles,
    alignmentSummary:
      alignmentText && alignmentSourceIds.length ? alignmentText : null,
    alignmentSourceIds,
    pitchAngle: pitchText && pitchSourceIds.length ? pitchText : null,
    pitchSourceIds,
    partnershipOpportunities,
    fitScore: score(parsed.fitScore),
    confidenceScore: confidence.confidence,
    confidenceBasis: confidence.basis,
    claims,
    limitations,
    sources: allSources,
  };
}
