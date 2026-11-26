import "server-only";

import { generateInKindDraft, InKindDraftError } from "@/lib/in-kind-draft";
import { IN_KIND_ASK_SLOT } from "@/lib/in-kind-draft-content";
import { getInKindList } from "@/lib/in-kind-sheets";
import { fillInKindTemplate } from "@/lib/in-kind";
import {
  hasPastStudentClubSponsorship,
  STUDENT_CLUB_SPONSOR_SOURCE_URL,
} from "@/lib/student-club-sponsors";
import { TEAM_MEMBERS, TEAM_NAMES } from "@/lib/sheet-writes";

const MAX_COMPANY_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 300;
const MAX_TEMPLATE_LENGTH = 5_000;

function stringField(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

  if (!isRecord(body)) {
    return Response.json(
      { error: "An in-kind company row is required." },
      { status: 400 },
    );
  }

  const input = body;
  const rowNumber =
    typeof input.rowNumber === "number" ? input.rowNumber : 0;
  const company = stringField(input.company, MAX_COMPANY_LENGTH);
  const senderName = stringField(input.senderName, 200);
  const subject = stringField(input.subject, MAX_SUBJECT_LENGTH);
  const template = stringField(input.template, MAX_TEMPLATE_LENGTH);

  if (
    rowNumber < 2 ||
    !company ||
    !subject ||
    !template ||
    !TEAM_NAMES.some((teamName) => teamName === senderName)
  ) {
    return Response.json(
      { error: "A valid company row, sender, subject, and template are required." },
      { status: 400 },
    );
  }

  try {
    const list = await getInKindList();
    const row = list.rows.find(
      (candidate) =>
        candidate.rowNumber === rowNumber && candidate.company === company,
    );

    if (!row) {
      return Response.json(
        { error: "That company row no longer matches the shared sheet. Refresh and try again." },
        { status: 409 },
      );
    }

    const senderRole =
      TEAM_MEMBERS.find((member) => member.name === senderName)?.role;
    if (!senderRole) {
      return Response.json(
        { error: "The selected sender does not have a configured role." },
        { status: 400 },
      );
    }

    const listedStudentClubSponsor =
      hasPastStudentClubSponsorship(company);
    const pastStudentClubSponsor = row.prev || listedStudentClubSponsor;
    const templateValues = {
      company,
      senderName,
      senderRole,
      inKindAsk: IN_KIND_ASK_SLOT,
    };
    const draft = await generateInKindDraft({
      company,
      senderName,
      senderRole,
      subject: fillInKindTemplate(subject, templateValues),
      filledTemplate: fillInKindTemplate(template, templateValues),
      pastStudentClubSponsor,
      sponsorHistorySourceUrl: listedStudentClubSponsor
        ? STUDENT_CLUB_SPONSOR_SOURCE_URL
        : null,
    });

    return Response.json(
      { draft },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof InKindDraftError) {
      return Response.json(
        { error: error.message, failure: error.failure },
        {
          status:
            error.failure === "configuration"
              ? 500
              : error.failure === "timeout"
                ? 504
                : 502,
        },
      );
    }

    return Response.json(
      { error: "The in-kind draft request failed safely." },
      { status: 500 },
    );
  }
}
