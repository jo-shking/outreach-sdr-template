import "server-only";

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

const MODEL = "deepseek/deepseek-v4-flash";

export async function POST() {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "OPENROUTER_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  try {
    const openRouterResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "user",
              content: "Reply with exactly: OpenRouter connection working.",
            },
          ],
          max_tokens: 20,
        }),
        cache: "no-store",
      },
    );

    if (!openRouterResponse.ok) {
      return Response.json(
        {
          error: "OpenRouter rejected the test request.",
          upstreamStatus: openRouterResponse.status,
        },
        { status: 502 },
      );
    }

    const data = (await openRouterResponse.json()) as OpenRouterResponse;
    const message = data.choices?.[0]?.message?.content;

    if (!message) {
      return Response.json(
        { error: "OpenRouter returned no message for the test request." },
        { status: 502 },
      );
    }

    return Response.json({
      response: message,
    });
  } catch {
    return Response.json(
      { error: "The server could not reach OpenRouter." },
      { status: 502 },
    );
  }
}
