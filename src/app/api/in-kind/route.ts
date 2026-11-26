import "server-only";

import {
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
} from "@/lib/google-sheets";
import { extractEmailAddress, IN_KIND_CONTACTED_STATUS } from "@/lib/in-kind";
import {
  addInKindCompany,
  getInKindList,
  markInKindSent,
} from "@/lib/in-kind-sheets";
import { TEAM_NAMES } from "@/lib/sheet-writes";

function errorResponse(error: unknown) {
  if (error instanceof GoogleSheetsConfigurationError) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (error instanceof GoogleSheetsAccessError) {
    return Response.json({ error: error.message }, { status: 502 });
  }
  if (error instanceof Error) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  return Response.json({ error: "The in-kind request failed." }, { status: 500 });
}

/** The in-kind rows from the shared Master Outreach Tracker. */
export async function GET() {
  try {
    const list = await getInKindList();
    return Response.json(
      { ...list, total: list.rows.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Adds one company and email after warning about possible duplicate names. */
export async function PUT(request: Request) {
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
  const company =
    typeof input.company === "string" ? input.company.trim().slice(0, 200) : "";
  const contactInfo =
    typeof input.contactInfo === "string"
      ? input.contactInfo.trim().slice(0, 320)
      : "";
  const confirmSimilar = input.confirmSimilar === true;

  if (!company) {
    return Response.json({ error: "Company is required." }, { status: 400 });
  }
  if (extractEmailAddress(contactInfo) !== contactInfo.toLowerCase()) {
    return Response.json(
      { error: "A valid email address is required." },
      { status: 400 },
    );
  }

  try {
    const result = await addInKindCompany({
      company,
      contactInfo,
      confirmSimilar,
    });
    if (!result.added) {
      return Response.json(
        {
          added: false,
          warning: "A similar company already exists.",
          similarCompanies: result.similarCompanies,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      { ...result },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Records manual outreach: request date, "Contacted", and coordinator. */
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
  const company =
    typeof input.company === "string" ? input.company.trim().slice(0, 200) : "";
  const contactedBy =
    typeof input.contactedBy === "string" ? input.contactedBy.trim() : "";

  if (!Number.isSafeInteger(rowNumber) || rowNumber < 2 || !company) {
    return Response.json(
      { error: "A row number and company are required." },
      { status: 400 },
    );
  }

  // The roster is the only valid attribution, same rule as the main tracker.
  if (!(TEAM_NAMES as readonly string[]).includes(contactedBy)) {
    return Response.json(
      { error: "Contacted by must be one of the team members." },
      { status: 400 },
    );
  }

  try {
    const result = await markInKindSent({
      rowNumber,
      company,
      status: IN_KIND_CONTACTED_STATUS,
      contactedBy,
      now: new Date().toLocaleDateString("en-CA"),
    });
    return Response.json(
      { saved: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
