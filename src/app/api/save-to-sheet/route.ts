import "server-only";

import {
  appendRows,
  applyCellUpdates,
  getCompanyRowKeys,
  getContactIds,
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
} from "@/lib/google-sheets";
import {
  buildContactRowUpdate,
  buildContactRow,
  buildResearchUpdates,
  companyIdFor,
  contactIdFor,
  findCompanyRow,
  findContactRow,
  OUTREACH_STATUSES,
  type ContactRow,
} from "@/lib/sheet-writes";

const MAX_NAME_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_EMAIL_LENGTH = 320;
const MAX_URL_LENGTH = 500;

function optionalString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) || null : null;
}

function outreachStatus(value: unknown): (typeof OUTREACH_STATUSES)[number] {
  const match = OUTREACH_STATUSES.find((status) => status === value);
  return match ?? "Not started";
}

function channel(value: unknown): ContactRow["channel"] {
  return value === "Email" || value === "LinkedIn" ? value : "";
}

/** Today in the sheet's own readable format, matching how dates already appear there. */
function today() {
  return new Date().toLocaleDateString("en-CA");
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
    return Response.json({ error: "A save action is required." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const action = optionalString(input.action, 40);
  const companyName = optionalString(input.companyName, MAX_NAME_LENGTH);

  if (!companyName) {
    return Response.json(
      { error: "The company name is required." },
      { status: 400 },
    );
  }

  if (action !== "research" && action !== "contact") {
    return Response.json(
      { error: `Unsupported action "${action}". Use "research" or "contact".` },
      { status: 400 },
    );
  }

  try {
    // Read the key columns immediately before writing, so a row that moved since the
    // page loaded is still found in its current position.
    const rows = await getCompanyRowKeys();
    const { rowNumber, existingCompanyId, existingWebsite } = findCompanyRow({
      rows,
      companyName,
      companyId: optionalString(input.companyId, MAX_NAME_LENGTH),
    });
    const companyId = existingCompanyId ?? companyIdFor(companyName);

    if (action === "research") {
      const research =
        input.research && typeof input.research === "object"
          ? (input.research as Record<string, unknown>)
          : {};

      const updates = buildResearchUpdates({
        rowNumber,
        existingCompanyId,
        existingWebsite,
        inferredWebsite: optionalString(input.inferredWebsite, 200),
        companyName,
        research: {
          alignmentSummary: optionalString(research.alignmentSummary, 45_000),
          companyOverview: optionalString(research.companyOverview, 45_000),
          fitScore: typeof research.fitScore === "number" ? research.fitScore : 0,
          confidenceScore:
            typeof research.confidenceScore === "number"
              ? research.confidenceScore
              : 0,
        },
        now: today(),
      });
      const cells = await applyCellUpdates(updates);

      return Response.json(
        { saved: "research", companyId, rowNumber, cells },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const contactInput =
      input.contact && typeof input.contact === "object"
        ? (input.contact as Record<string, unknown>)
        : null;
    const contactName = optionalString(contactInput?.name, MAX_NAME_LENGTH);

    if (!contactName) {
      return Response.json(
        { error: "The contact name is required." },
        { status: 400 },
      );
    }

    const linkedinUrl = optionalString(contactInput?.linkedinUrl, MAX_URL_LENGTH);
    const status = outreachStatus(input.outreachStatus);
    const reachedOut = status !== "Not started";
    const row: ContactRow = {
      contactId: contactIdFor(companyId, linkedinUrl, contactName),
      companyId,
      companyName,
      name: contactName,
      title: optionalString(contactInput?.title, MAX_TITLE_LENGTH) ?? "",
      workEmail: optionalString(contactInput?.workEmail, MAX_EMAIL_LENGTH) ?? "",
      linkedinUrl: linkedinUrl ?? "",
      isAlum: contactInput?.isAlum === true,
      outreachStatus: status,
      channel: channel(input.channel),
      reachedOutBy: optionalString(input.reachedOutBy, MAX_NAME_LENGTH) ?? "",
      // Only stamp a date once outreach has actually happened, so "Not started" rows
      // do not look like they were contacted today.
      dateReachedOut: reachedOut
        ? (optionalString(input.dateReachedOut, 40) ?? today())
        : "",
      dateFollowedUp: optionalString(input.dateFollowedUp, 40) ?? "",
    };

    const existingRow = findContactRow(await getContactIds(), row.contactId);

    if (existingRow) {
      const cells = await applyCellUpdates([
        buildContactRowUpdate(existingRow, row),
      ]);

      return Response.json(
        { saved: "contact", mode: "updated", contactId: row.contactId, rowNumber: existingRow, cells },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const appended = await appendRows("Contacts", [buildContactRow(row)]);

    return Response.json(
      { saved: "contact", mode: "appended", contactId: row.contactId, rows: appended },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GoogleSheetsConfigurationError) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (error instanceof GoogleSheetsAccessError) {
      return Response.json({ error: error.message }, { status: 502 });
    }

    // findCompanyRow throws a plain Error with an explanation the user needs to read:
    // the account is missing from the sheet, or its name is ambiguous.
    if (error instanceof Error) {
      return Response.json({ error: error.message }, { status: 422 });
    }

    return Response.json(
      { error: "The sheet update failed safely." },
      { status: 500 },
    );
  }
}
