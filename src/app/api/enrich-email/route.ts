import "server-only";

import {
  ApolloConfigurationError,
  ApolloConnectionError,
  enrichProfessionalEmail,
} from "@/lib/apollo";

const MAX_NAME_LENGTH = 200;
const MAX_LINKEDIN_URL_LENGTH = 500;

function stringInput(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : "";
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

  const input = body && typeof body === "object" && !Array.isArray(body)
    ? Object.fromEntries(Object.entries(body))
    : null;
  const name = stringInput(input?.name, MAX_NAME_LENGTH);
  const companyName = stringInput(input?.companyName, MAX_NAME_LENGTH);
  const linkedinUrl = stringInput(
    input?.linkedinUrl,
    MAX_LINKEDIN_URL_LENGTH,
  );

  if (!name || !companyName || !linkedinUrl) {
    return Response.json(
      { error: "Name, company name, and LinkedIn URL are required." },
      { status: 400 },
    );
  }

  try {
    const result = await enrichProfessionalEmail({
      name,
      companyName,
      linkedinUrl,
    });

    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApolloConfigurationError) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (error instanceof ApolloConnectionError) {
      return Response.json(
        { error: error.message, upstreamStatus: error.status },
        { status: 502 },
      );
    }

    return Response.json(
      { error: "The Apollo enrichment request failed safely." },
      { status: 500 },
    );
  }
}
