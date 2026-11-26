import "server-only";

import {
  ApifyConfigurationError,
  ApifyConnectionError,
  testApifyConnection,
} from "@/lib/apify";

function safeErrorResponse(error: unknown) {
  if (error instanceof ApifyConfigurationError) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (error instanceof ApifyConnectionError) {
    return Response.json(
      { error: error.message, upstreamStatus: error.status },
      { status: 502 },
    );
  }

  return Response.json(
    { error: "The Apify request failed safely." },
    { status: 500 },
  );
}

export async function POST() {
  try {
    const result = await testApifyConnection();

    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
