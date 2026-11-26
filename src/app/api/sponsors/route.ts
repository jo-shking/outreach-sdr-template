import "server-only";

import {
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
} from "@/lib/google-sheets";
import { parseAmount, SPONSORSHIP_GOAL } from "@/lib/follow-ups";
import { addSponsor, listSponsors } from "@/lib/follow-ups-sheets";
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
  return Response.json({ error: "The sponsor request failed." }, { status: 500 });
}

export async function GET() {
  try {
    const sponsors = await listSponsors();
    const total = sponsors.reduce((sum, sponsor) => sum + sponsor.amount, 0);
    return Response.json(
      { sponsors, total, goal: SPONSORSHIP_GOAL },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Records one confirmed sponsorship: name and amount. */
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
  const sponsor =
    typeof input.sponsor === "string" ? input.sponsor.trim().slice(0, 200) : "";
  const amount =
    typeof input.amount === "string"
      ? parseAmount(input.amount)
      : typeof input.amount === "number" && input.amount > 0
        ? input.amount
        : null;
  const addedBy =
    typeof input.addedBy === "string" ? input.addedBy.trim() : "";

  if (!sponsor) {
    return Response.json({ error: "The sponsor name is required." }, { status: 400 });
  }
  if (amount === null) {
    return Response.json(
      { error: "The amount must be a positive number, like 500 or 1.5k." },
      { status: 400 },
    );
  }
  if (!(TEAM_NAMES as readonly string[]).includes(addedBy)) {
    return Response.json(
      { error: "Added by must be one of the team members." },
      { status: 400 },
    );
  }

  try {
    await addSponsor({
      sponsor,
      amount,
      date: new Date().toLocaleDateString("en-CA"),
      addedBy,
    });
    return Response.json(
      { saved: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
