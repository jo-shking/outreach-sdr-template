import "server-only";

type ExaSearchResult = {
  title?: string | null;
  url?: string | null;
  highlights?: string[] | null;
  entities?: Array<{
    type?: string;
    properties?: { name?: string | null };
  }> | null;
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
};

const MAX_FIELD_LENGTH = 2_000;

function cleanField(value: unknown) {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_FIELD_LENGTH)
    : "";
}

export async function POST(request: Request) {
  const apiKey = process.env.EXA_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "EXA_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  let requestBody: unknown;

  try {
    requestBody = await request.json();
  } catch {
    return Response.json(
      { error: "The request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (
    !requestBody ||
    typeof requestBody !== "object" ||
    !("icp" in requestBody) ||
    !requestBody.icp ||
    typeof requestBody.icp !== "object"
  ) {
    return Response.json({ error: "A valid ICP is required." }, { status: 400 });
  }

  const icp = requestBody.icp as Record<string, unknown>;
  const objective = cleanField(icp.objective);

  if (!objective) {
    return Response.json(
      { error: "The ICP objective is required." },
      { status: 400 },
    );
  }

  const query = [
    `Find companies for this objective: ${objective}`,
    `Geography: ${cleanField(icp.geography) || "not specified"}.`,
    `Employee range: ${cleanField(icp.employeeMin) || "not specified"} to ${cleanField(icp.employeeMax) || "not specified"}.`,
    `Annual revenue range in CAD: ${cleanField(icp.revenueMin) || "not specified"} to ${cleanField(icp.revenueMax) || "not specified"}.`,
    `Required criteria: ${cleanField(icp.requiredCriteria) || "none specified"}.`,
    `Preferred criteria: ${cleanField(icp.preferredCriteria) || "none specified"}.`,
    `Exclude companies matching: ${cleanField(icp.excludedCriteria) || "none specified"}.`,
    "Return company candidates only and leave unsupported facts unknown.",
  ].join(" ");

  try {
    const exaResponse = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        type: "auto",
        category: "company",
        numResults: 10,
        contents: { highlights: true },
      }),
      cache: "no-store",
    });

    if (!exaResponse.ok) {
      return Response.json(
        {
          error: "Exa rejected the lead search request.",
          upstreamStatus: exaResponse.status,
        },
        { status: 502 },
      );
    }

    const data = (await exaResponse.json()) as ExaSearchResponse;
    const results = (data.results ?? []).slice(0, 10).flatMap((result) => {
      if (!result.url) return [];

      const company = result.entities?.find((entity) => entity.type === "company");
      const text = result.highlights?.filter(Boolean).join("\n\n").trim() || null;

      return [
        {
          companyName: company?.properties?.name ?? null,
          title: result.title ?? null,
          url: result.url,
          text,
        },
      ];
    });

    return Response.json({ results });
  } catch {
    return Response.json(
      { error: "The server could not reach Exa." },
      { status: 502 },
    );
  }
}
