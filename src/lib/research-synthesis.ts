export type ResearchSourceReference = {
  id: string;
  url: string;
};

export type WebSearchCitation = {
  url: string;
  title: string | null;
  evidence: string | null;
};

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function comparableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    // Exa and native search disagree on the www prefix for the same page, so treat
    // both spellings as one URL when deduplicating and when resolving citations.
    url.hostname = url.hostname.replace(/^www\./i, "");
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function optionalText(value: unknown, maxLength: number): string | null {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

export function extractWebSearchCitations(
  value: unknown,
  excludeUrls: readonly string[] = [],
): WebSearchCitation[] {
  const annotations = property(value, "annotations");
  if (!Array.isArray(annotations)) return [];

  const seenUrls = new Set(
    excludeUrls.flatMap((url) => {
      const normalized = comparableUrl(url);
      return normalized ? [normalized] : [];
    }),
  );

  return annotations.flatMap((annotation) => {
    if (property(annotation, "type") !== "url_citation") return [];

    const citation = property(annotation, "url_citation") ?? annotation;
    const rawUrl = property(citation, "url");
    if (typeof rawUrl !== "string") return [];

    const normalizedUrl = comparableUrl(rawUrl);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) return [];

    const protocol = new URL(rawUrl).protocol;
    if (protocol !== "https:" && protocol !== "http:") return [];

    seenUrls.add(normalizedUrl);
    return [
      {
        url: rawUrl,
        title: optionalText(property(citation, "title"), 500),
        evidence: optionalText(property(citation, "content"), 1_500),
      },
    ];
  });
}

export function normalizeSourceReferences(
  value: unknown,
  sources: readonly ResearchSourceReference[],
): string[] {
  if (!Array.isArray(value)) return [];

  const ids = new Map(sources.map((source) => [source.id.toUpperCase(), source.id]));
  const urls = new Map(
    sources.flatMap((source) => {
      const normalized = comparableUrl(source.url);
      return normalized ? [[normalized, source.id] as const] : [];
    }),
  );
  const normalized = value.flatMap((reference) => {
    if (typeof reference !== "string") return [];

    const candidate = reference.trim();
    if (!candidate) return [];

    const canonicalId = /^S?\d+$/i.test(candidate)
      ? ids.get(`S${candidate.replace(/^S/i, "")}`.toUpperCase())
      : ids.get(candidate.toUpperCase());
    if (canonicalId) return [canonicalId];

    const url = comparableUrl(candidate);
    const sourceId = url ? urls.get(url) : undefined;
    return sourceId ? [sourceId] : [];
  });

  return [...new Set(normalized)];
}

function hasSupportedText(
  value: unknown,
  sourceReferences: unknown,
  sources: readonly ResearchSourceReference[],
) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    normalizeSourceReferences(sourceReferences, sources).length > 0
  );
}

function arrayHasSupportedItem(
  value: unknown,
  textFields: readonly string[],
  sources: readonly ResearchSourceReference[],
) {
  return (
    Array.isArray(value) &&
    value.some((item) =>
      textFields.some((field) =>
        hasSupportedText(
          property(item, field),
          property(item, "sourceIds"),
          sources,
        ),
      ),
    )
  );
}

export function hasUsableSynthesis(
  value: unknown,
  sources: readonly ResearchSourceReference[],
): boolean {
  return (
    hasSupportedText(
      property(value, "companyOverview"),
      property(value, "companyOverviewSourceIds"),
      sources,
    ) ||
    hasSupportedText(
      property(value, "alignmentSummary"),
      property(value, "alignmentSourceIds"),
      sources,
    ) ||
    hasSupportedText(
      property(value, "pitchAngle"),
      property(value, "pitchSourceIds"),
      sources,
    ) ||
    arrayHasSupportedItem(property(value, "commonRoles"), ["role", "evidence"], sources) ||
    arrayHasSupportedItem(
      property(value, "partnershipOpportunities"),
      ["title", "rationale"],
      sources,
    ) ||
    arrayHasSupportedItem(property(value, "claims"), ["claim", "evidence"], sources)
  );
}

export function acceptsNativeSearchSynthesis(
  value: unknown,
  nativeSources: readonly ResearchSourceReference[],
  allSources: readonly ResearchSourceReference[],
): boolean {
  // Requiring at least one native source proves the web-search tool actually ran and
  // returned citable URLs. Without it, a run that produced no annotations could still be
  // accepted by reciting URLs from model memory, which is the uncited knowledge we reject.
  return nativeSources.length > 0 && hasUsableSynthesis(value, allSources);
}

// Models under response_format json_object still occasionally wrap the object in a
// markdown fence or add prose around it. Recover the object rather than discarding a
// complete synthesis over formatting.
export function parseResearchObject(content: string): Record<string, unknown> | null {
  const candidates = [content];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(content.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate shape.
    }
  }

  return null;
}
