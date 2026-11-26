import "server-only";

import {
  GmailConfigurationError,
  GmailSendError,
  sendGmailMessage,
} from "@/lib/gmail-send";
import { GoogleSheetsAccessError } from "@/lib/google-sheets";
import { extractEmailAddress, IN_KIND_CONTACTED_STATUS } from "@/lib/in-kind";
import { vancouverDate } from "@/lib/in-kind-follow-ups";
import { getInKindList, markInKindSent } from "@/lib/in-kind-sheets";
import { TEAM_NAMES } from "@/lib/sheet-writes";

function stringField(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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

  const input =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const rowNumber = typeof input.rowNumber === "number" ? input.rowNumber : 0;
  const company = stringField(input.company, 200);
  const to = stringField(input.to, 320);
  const subject = stringField(input.subject, 300);
  const messageBody = stringField(input.body, 5_000);
  const senderName = stringField(input.senderName, 200);
  const confirmed = input.confirmed === true;

  if (
    !Number.isSafeInteger(rowNumber) || rowNumber < 2 ||
    !company ||
    extractEmailAddress(to) !== to.toLowerCase() ||
    !subject ||
    !messageBody ||
    !confirmed
  ) {
    return Response.json(
      {
        error:
          "A valid company row, recipient, subject, message, and final confirmation are required.",
      },
      { status: 400 },
    );
  }
  if (!(TEAM_NAMES as readonly string[]).includes(senderName)) {
    return Response.json(
      { error: "Sender must be one of the team members." },
      { status: 400 },
    );
  }

  try {
    const list = await getInKindList();
    const row = list.rows.find(
      (candidate) =>
        candidate.rowNumber === rowNumber && candidate.company === company,
    );
    const sheetEmail = row ? extractEmailAddress(row.contactInfo) : null;
    if (!row || !sheetEmail || sheetEmail.toLowerCase() !== to.toLowerCase()) {
      return Response.json(
        {
          error:
            "That company or email no longer matches Google Sheets. Refresh before sending.",
        },
        { status: 409 },
      );
    }
    if (/\b(sent|contacted)\b/i.test(row.status)) {
      return Response.json(
        { error: "This company is already marked as contacted." },
        { status: 409 },
      );
    }

    const sent = await sendGmailMessage({ to: sheetEmail, subject, body: messageBody });
    try {
      await markInKindSent({
        rowNumber,
        company,
        status: IN_KIND_CONTACTED_STATUS,
        contactedBy: senderName,
        now: vancouverDate(),
        gmailMessageId: sent.messageId,
      });
      return Response.json(
        { sent: true, recorded: true, ...sent },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      return Response.json(
        {
          sent: true,
          recorded: false,
          ...sent,
          warning:
            "Gmail sent the message, but Google Sheets could not record it. Do not send it again. Update the Sheet manually.",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch (error) {
    if (error instanceof GmailConfigurationError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof GmailSendError) {
      return Response.json(
        { error: error.message, failure: error.failure },
        { status: error.failure === "rate_limit" ? 429 : 502 },
      );
    }
    if (error instanceof GoogleSheetsAccessError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return Response.json(
      { error: "The email send failed safely." },
      { status: 500 },
    );
  }
}
