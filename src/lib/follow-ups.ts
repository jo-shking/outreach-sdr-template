// Follow-up reminders and the sponsorship goal, both stored in the app's own
// tracker spreadsheet in two tabs the app creates: "Follow-ups" and "Sponsors".
// Kept pure so row building, date logic, and amount parsing are unit tested.
// Sheet1 is never touched; the write layer's guard still applies.

export const FOLLOW_UPS_TAB = "Follow-ups";
export const SPONSORS_TAB = "Sponsors";

export const FOLLOW_UPS_HEADERS = [
  "Company",
  "Expected Reply",
  "Note",
  "Added By",
  "Added On",
  "Status",
  // Written by the Apps Script reminder when it emails, so it never re-sends.
  "Reminded On",
] as const;

export const SPONSORS_HEADERS = [
  "Sponsor",
  "Amount",
  "Date",
  "Added By",
] as const;

export const FOLLOW_UP_STATUSES = ["Waiting", "Heard back"] as const;

/** The season target the goal meter fills toward. */
export const SPONSORSHIP_GOAL = 10_000;

export type FollowUpRow = {
  rowNumber: number;
  company: string;
  expectedReply: string;
  note: string;
  addedBy: string;
  addedOn: string;
  status: string;
  remindedOn: string;
};

export type SponsorRow = {
  rowNumber: number;
  sponsor: string;
  amount: number;
  date: string;
  addedBy: string;
};

function cell(row: readonly unknown[], index: number) {
  const value = row[index];
  return value === undefined || value === null ? "" : String(value).trim();
}

export function mapFollowUpRows(
  rows: ReadonlyArray<readonly unknown[]>,
): FollowUpRow[] {
  return rows.flatMap((row, index) => {
    const company = cell(row, 0);
    if (!company) return [];
    return [
      {
        rowNumber: index + 2,
        company,
        expectedReply: cell(row, 1),
        note: cell(row, 2),
        addedBy: cell(row, 3),
        addedOn: cell(row, 4),
        status: cell(row, 5) || "Waiting",
        remindedOn: cell(row, 6),
      },
    ];
  });
}

/**
 * Amounts arrive as user text ("1,500", "$2000", "2k"). Parsed conservatively:
 * anything unparseable is rejected rather than guessed at.
 */
export function parseAmount(value: string): number | null {
  const trimmed = value.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!trimmed) return null;

  const thousands = trimmed.endsWith("k");
  const numeric = Number(thousands ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const amount = thousands ? numeric * 1000 : numeric;
  return Math.round(amount * 100) / 100;
}

export function mapSponsorRows(
  rows: ReadonlyArray<readonly unknown[]>,
): SponsorRow[] {
  return rows.flatMap((row, index) => {
    const sponsor = cell(row, 0);
    const amount = parseAmount(cell(row, 1));
    if (!sponsor || amount === null) return [];
    return [
      {
        rowNumber: index + 2,
        sponsor,
        amount,
        date: cell(row, 2),
        addedBy: cell(row, 3),
      },
    ];
  });
}

export function buildFollowUpRow(input: {
  company: string;
  expectedReply: string;
  note: string;
  addedBy: string;
  addedOn: string;
}): string[] {
  return [
    input.company,
    input.expectedReply,
    input.note,
    input.addedBy,
    input.addedOn,
    "Waiting",
    "",
  ];
}

export function buildSponsorRow(input: {
  sponsor: string;
  amount: number;
  date: string;
  addedBy: string;
}): string[] {
  return [input.sponsor, String(input.amount), input.date, input.addedBy];
}

/** yyyy-mm-dd, matching how the app stamps dates elsewhere. */
export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const parsed = new Date(`${value.trim()}T00:00:00`);
  return !Number.isNaN(parsed.getTime());
}

/**
 * How a follow-up date relates to today. String comparison is safe because
 * both sides are yyyy-mm-dd. A malformed date reads as upcoming rather than
 * screaming overdue at a typo.
 */
export function dueState(
  expectedReply: string,
  today: string,
): "overdue" | "today" | "upcoming" | "unknown" {
  const date = expectedReply.trim();
  if (!isIsoDate(date)) return "unknown";
  if (date < today) return "overdue";
  if (date === today) return "today";
  return "upcoming";
}
