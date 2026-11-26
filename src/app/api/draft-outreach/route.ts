import "server-only";

import { DEFAULT_SENDER } from "@/lib/outreach-content";
import {
  generateEmailDraft,
  generateLinkedInNote,
  OutreachDraftConfigurationError,
  OutreachDraftError,
} from "@/lib/outreach-draft";

const MAX_NAME_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_EVIDENCE_LENGTH = 1_500;
const MAX_EMAIL_LENGTH = 320;
const MAX_URL_LENGTH = 500;
const MAX_MISA_CONTEXT_LENGTH = 5_000;

function optionalString(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

function sfuConnection(value: unknown): "alumni" | "education" | null {
  if (value === "alumni") return "alumni";
  if (value === "education") return "education";
  return null;
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
    return Response.json(
      { error: "A contact and account are required." },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const channel = optionalString(input.channel, 50) ?? "email";

  if (channel !== "email" && channel !== "linkedin_note") {
    return Response.json(
      { error: `Unsupported channel "${channel}". Use "email" or "linkedin_note".` },
      { status: 400 },
    );
  }

  const companyName = optionalString(input.companyName, MAX_NAME_LENGTH);
  const contactInput =
    input.contact && typeof input.contact === "object" && !Array.isArray(input.contact)
      ? (input.contact as Record<string, unknown>)
      : null;
  const contactName = optionalString(contactInput?.name, MAX_NAME_LENGTH);
  const currentCompany = optionalString(contactInput?.currentCompany, MAX_NAME_LENGTH);

  if (!companyName || !contactName || !currentCompany) {
    return Response.json(
      {
        error:
          "The account name, contact name, and contact's current company are required.",
      },
      { status: 400 },
    );
  }

  const senderInput =
    input.sender && typeof input.sender === "object" && !Array.isArray(input.sender)
      ? (input.sender as Record<string, unknown>)
      : null;
  const startedAt = Date.now();

  // Both channels take the same verified inputs; only the output shape differs.
  const shared = {
    companyName,
    research: input.research,
    contact: {
      name: contactName,
      title: optionalString(contactInput?.title, MAX_TITLE_LENGTH) ?? "",
      currentCompany,
      currentEmploymentEvidence:
        optionalString(contactInput?.currentEmploymentEvidence, MAX_EVIDENCE_LENGTH) ??
        "Not provided",
      sfuConnection: sfuConnection(contactInput?.sfuConnection),
      sfuEvidence: optionalString(contactInput?.sfuEvidence, MAX_EVIDENCE_LENGTH),
    },
    sender: {
      name: optionalString(senderInput?.name, MAX_NAME_LENGTH) ?? DEFAULT_SENDER.name,
      role: optionalString(senderInput?.role, MAX_TITLE_LENGTH) ?? DEFAULT_SENDER.role,
    },
    misaEvents: optionalString(input.misaEvents, MAX_MISA_CONTEXT_LENGTH),
    partnershipFormats: optionalString(
      input.partnershipFormats,
      MAX_MISA_CONTEXT_LENGTH,
    ),
  };

  try {
    const draft =
      channel === "linkedin_note"
        ? await generateLinkedInNote({
            ...shared,
            profileUrl: optionalString(input.profileUrl, MAX_URL_LENGTH),
          })
        : await generateEmailDraft({
            ...shared,
            recipientEmail: optionalString(input.recipientEmail, MAX_EMAIL_LENGTH),
          });

    return Response.json(
      { draft },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof OutreachDraftConfigurationError) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (error instanceof OutreachDraftError) {
      // A mismatch is a rejected input, not an upstream fault.
      if (error.failure === "mismatch") {
        return Response.json(
          { error: error.message, failure: error.failure },
          { status: 422 },
        );
      }

      console.error("Outreach draft provider failure", {
        failure: error.failure,
        upstreamStatus: error.status ?? null,
        companyName,
        durationMs: Date.now() - startedAt,
      });

      return Response.json(
        {
          error: error.message,
          failure: error.failure,
          upstreamStatus: error.status,
        },
        { status: error.failure === "timeout" ? 504 : 502 },
      );
    }

    console.error("Unexpected outreach draft failure", {
      companyName,
      durationMs: Date.now() - startedAt,
    });

    return Response.json(
      { error: "The outreach draft request failed safely." },
      { status: 500 },
    );
  }
}
