import "server-only";

import { buildInKindFollowUpDraft, buildInKindFollowUpQueues, vancouverDate } from "@/lib/in-kind-follow-ups";
import { followUpReviewId, getInKindFollowUpSource, markInKindFollowUpSent } from "@/lib/in-kind-sheets";
import { TEAM_NAMES } from "@/lib/sheet-writes";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const { columns, dataRows, completedColumn } = await getInKindFollowUpSource();
    const queues = buildInKindFollowUpQueues(dataRows, columns, TEAM_NAMES, vancouverDate(), completedColumn);
    const params = new URL(request.url).searchParams;
    if (params.has("draftFor")) {
      const rowNumber = Number(params.get("draftFor"));
      const company = params.get("company") ?? "";
      const draft = Number.isSafeInteger(rowNumber) && rowNumber >= 2 && company
        ? buildInKindFollowUpDraft(queues, dataRows, columns, rowNumber, company)
        : null;
      if (!draft) {
        return Response.json({
          error: "This item is no longer in the due queue or does not have one identifiable email address.",
        }, { status: 409, headers });
      }
      return Response.json({ draft, reviewId: followUpReviewId(dataRows, columns, rowNumber, draft.to) }, { headers });
    }
    return Response.json({ queues }, { headers });
  } catch {
    return Response.json(
      { error: "Could not load follow-ups from the in-kind tracker." },
      { status: 502, headers },
    );
  }
}

export async function PATCH(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      !request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Confirm the send from the MISA app." }, { status: 403, headers });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400, headers });
  }
  const { rowNumber, company, reviewId, confirmed } = (body ?? {}) as Record<string, unknown>;
  if (confirmed !== true || typeof rowNumber !== "number" || !Number.isSafeInteger(rowNumber) ||
      rowNumber < 2 || typeof company !== "string" || !company || company.length > 300 ||
      typeof reviewId !== "string" || !/^[a-f0-9]{64}$/.test(reviewId)) {
    return Response.json({ error: "An approved follow-up and manual send confirmation are required." }, { status: 400, headers });
  }
  try {
    const saved = await markInKindFollowUpSent({ rowNumber, company, reviewId, teamNames: TEAM_NAMES });
    if (!saved) {
      return Response.json({ error: "This follow-up changed or was already marked. Refresh the queue." }, { status: 409, headers });
    }
    return Response.json({ saved: true }, { headers });
  } catch {
    return Response.json({ error: "Could not update Sheets. Refresh the queue before retrying." }, { status: 502, headers });
  }
}
