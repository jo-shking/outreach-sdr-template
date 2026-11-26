import "server-only";

import {
  ApolloConfigurationError,
  ApolloConnectionError,
  revealApolloContact,
} from "@/lib/apollo";

const MAX_ID_LENGTH = 100;
const MAX_DOMAIN_LENGTH = 300;

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
    return Response.json({ error: "A contact is required." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const apolloId = optionalString(input.apolloId, MAX_ID_LENGTH);

  if (!apolloId) {
    return Response.json(
      { error: "The Apollo contact id is required." },
      { status: 400 },
    );
  }

  try {
    // Spends one Apollo credit when Apollo has data to return.
    const result = await revealApolloContact({
      apolloId,
      expectedDomain: optionalString(input.companyDomain, MAX_DOMAIN_LENGTH),
    });

    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
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
      { error: "The contact reveal failed safely." },
      { status: 500 },
    );
  }
}
