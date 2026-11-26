import "server-only";

import { parseResearchObject } from "@/lib/research-synthesis";
import {
  assembleInKindDraftBody,
  getInKindAskParagraph,
  hasExactlyOneInKindAskSlot,
  isInKindAskVariant,
} from "@/lib/in-kind-draft-content";

const DEFAULT_DRAFT_MODEL = "openai/gpt-5.2";
const MAX_DRAFT_TOKENS = 8_000;

export type InKindDraft = {
  subject: string;
  body: string;
  pastStudentClubSponsor: boolean;
  sponsorHistorySourceUrl: string | null;
};

export class InKindDraftError extends Error {
  constructor(
    message: string,
    public readonly failure:
      | "configuration"
      | "timeout"
      | "network"
      | "rejected"
      | "invalid_response",
    public readonly status?: number,
  ) {
    super(message);
  }
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function requiredApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new InKindDraftError(
      "OPENROUTER_API_KEY is not configured on the server.",
      "configuration",
    );
  }
  return apiKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function generateInKindDraft({
  company,
  senderName,
  senderRole,
  subject,
  filledTemplate,
  pastStudentClubSponsor,
  sponsorHistorySourceUrl,
}: {
  company: string;
  senderName: string;
  senderRole: string;
  subject: string;
  filledTemplate: string;
  pastStudentClubSponsor: boolean;
  sponsorHistorySourceUrl: string | null;
}): Promise<InKindDraft> {
  if (!hasExactlyOneInKindAskSlot(filledTemplate)) {
    throw new InKindDraftError(
      "The editable template must contain exactly one {inKindAsk} slot.",
      "invalid_response",
    );
  }

  const model =
    process.env.OPENROUTER_DRAFT_MODEL?.trim() || DEFAULT_DRAFT_MODEL;
  const historyInstruction = pastStudentClubSponsor
    ? [
        "The supplied sponsor record confirms that this company has supported a university student club.",
        "Do not mention that history in your response because the server will add the approved acknowledgment after validation.",
      ].join(" ")
    : [
        "There is no verified past student-club sponsorship signal for this company.",
        "Do not imply any prior sponsorship, donation, partnership, or support.",
      ].join(" ");

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + requiredApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: MAX_DRAFT_TOKENS,
        messages: [
          {
            role: "system",
            content: [
              "Choose the best approved ask variant for a professional Example Student Association in-kind sponsorship email.",
              "Use only the supplied template and sponsor-history signal.",
              'Choose exactly one of "warm", "direct", or "concise". The server assembles all email text from approved wording.',
              historyInstruction,
              "Return JSON only with one askVariant field.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              "Company: " + company,
              "Sender: " + senderName + ", " + senderRole,
              "Requested subject: " + subject,
              "",
              "Approved template:",
              filledTemplate,
            ].join("\n"),
          },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new InKindDraftError(
      isTimeoutError(error)
        ? "OpenRouter took longer than 60 seconds to draft the email."
        : "The server could not reach OpenRouter to draft the email.",
      isTimeoutError(error) ? "timeout" : "network",
    );
  }

  if (!response.ok) {
    throw new InKindDraftError(
      "OpenRouter rejected the in-kind draft request.",
      "rejected",
      response.status,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new InKindDraftError(
      "OpenRouter returned an unreadable in-kind draft.",
      "invalid_response",
    );
  }

  const choices =
    isRecord(data) && Array.isArray(data.choices) ? data.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : null;
  const message =
    firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
  const content =
    message && typeof message.content === "string" ? message.content : null;
  const parsed = content ? parseResearchObject(content) : null;
  const askVariant = parsed?.askVariant;
  if (!isInKindAskVariant(askVariant)) {
    throw new InKindDraftError(
      "OpenRouter returned an invalid in-kind draft selection.",
      "invalid_response",
    );
  }
  const askParagraph = getInKindAskParagraph(askVariant);

  let draftedBody: string;
  try {
    draftedBody = assembleInKindDraftBody({
      filledTemplate,
      askParagraph,
      pastStudentClubSponsor,
    });
  } catch {
    throw new InKindDraftError(
      "The editable template no longer contains an in-kind ask paragraph.",
      "invalid_response",
    );
  }

  return {
    subject,
    body: draftedBody,
    pastStudentClubSponsor,
    sponsorHistorySourceUrl,
  };
}
