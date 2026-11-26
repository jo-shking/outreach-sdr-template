import "server-only";

import {
  ApolloConfigurationError,
  ApolloConnectionError,
  checkApolloCapabilities,
} from "@/lib/apollo";

export async function POST() {
  try {
    const result = await checkApolloCapabilities();

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
      { error: "The Apollo connection test failed safely." },
      { status: 500 },
    );
  }
}
