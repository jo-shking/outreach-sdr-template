import { MISA_MAILBOX } from "./misa-mailbox.ts";

// The in-kind outreach flow works against the shared "Master Outreach Tracker"
// (Victor's spreadsheet), not the app's own Monetary Tracker. Contacts already
// exist there — no discovery, no AI. The app only: lists the rows, opens a
// prefilled Gmail template, and records date / status / who sent it.
//
// Kept pure so column mapping and cell addressing are unit tested: this is
// someone else's live sheet, and a wrong range would trash their data.

import {
  DEFAULT_IN_KIND_ASK_PARAGRAPH,
  IN_KIND_ASK_SLOT,
} from "./in-kind-draft-content.ts";

export type CellUpdate = {
  range: string;
  values: string[][];
};

/** Column indexes (0-based) located from the tab's own header row. */
export type InKindColumns = {
  dateOfReq: number;
  company: number;
  contactInfo: number;
  prev: number | null;
  status: number;
  contactedBy: number | null;
  gmailMessageId: number | null;
};

export type InKindRow = {
  rowNumber: number;
  company: string;
  contactInfo: string;
  prev: boolean;
  dateOfReq: string;
  status: string;
  contactedBy: string;
};

function headerIndex(header: readonly string[], wanted: string) {
  return header.findIndex(
    (cell) => cell.trim().toLowerCase() === wanted.toLowerCase(),
  );
}

/**
 * Locates the columns by header text rather than fixed positions, so a column
 * someone inserts in the shared sheet shifts nothing onto the wrong cells.
 * PREV is optional because the current tracker no longer carries that legacy
 * flag. CONTACTED BY is also optional — the server adds it when missing.
 */
export function findInKindColumns(header: readonly string[]): InKindColumns {
  const dateOfReq = headerIndex(header, "DATE OF REQ");
  const company = headerIndex(header, "COMPANY");
  const contactInfo = headerIndex(header, "CONTACT INFO");
  const prev = headerIndex(header, "PREV");
  const status = headerIndex(header, "STATUS");
  const contactedBy = headerIndex(header, "CONTACTED BY");
  const gmailMessageId = headerIndex(header, "GMAIL MESSAGE ID");

  if ([dateOfReq, company, contactInfo, status].some((i) => i === -1)) {
    throw new Error(
      "The in-kind tab's header row is missing an expected column (DATE OF REQ, COMPANY, CONTACT INFO, STATUS). Refusing to guess positions.",
    );
  }

  return {
    dateOfReq,
    company,
    contactInfo,
    prev: prev === -1 ? null : prev,
    status,
    contactedBy: contactedBy === -1 ? null : contactedBy,
    gmailMessageId: gmailMessageId === -1 ? null : gmailMessageId,
  };
}

function cell(row: readonly unknown[], index: number) {
  const value = row[index];
  return value === undefined || value === null ? "" : String(value).trim();
}

/** Maps sheet rows to the shape the UI needs. rows[0] is spreadsheet row 2. */
export function mapInKindRows(
  rows: ReadonlyArray<readonly unknown[]>,
  columns: InKindColumns,
): InKindRow[] {
  return rows.flatMap((row, index) => {
    const company = cell(row, columns.company);
    if (!company) return [];

    return [
      {
        rowNumber: index + 2,
        company,
        contactInfo: cell(row, columns.contactInfo),
        prev:
          columns.prev === null
            ? false
            : /^yes/i.test(cell(row, columns.prev)),
        dateOfReq: cell(row, columns.dateOfReq),
        status: cell(row, columns.status),
        contactedBy:
          columns.contactedBy === null ? "" : cell(row, columns.contactedBy),
      },
    ];
  });
}

export const IN_KIND_CONTACTED_STATUS = "Contacted";

export function isInKindContacted(status: string) {
  return /^(contacted|sent)$/i.test(status.trim());
}

/**
 * What kind of contact route a row has. Many rows hold a web form URL or a
 * note like "online form" instead of an address — those cannot be emailed.
 * Phone numbers are skipped entirely: this outreach is email or web form only.
 */
export function classifyContactInfo(
  info: string,
): "email" | "url" | "phone" | "other" {
  const trimmed = info.trim();
  if (!trimmed) return "other";
  if (extractEmailAddress(trimmed)) return "email";
  if (/^(https?:\/\/|www\.)/i.test(trimmed)) return "url";
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (!/[a-z@]/i.test(trimmed) && digits.length >= 7) return "phone";
  return "other";
}

/** Returns one unambiguous email even when the Sheet cell also contains a phone number. */
export function extractEmailAddress(info: string) {
  const matches = info.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  const unique = [...new Set(matches.map((match) => match.toLowerCase()))];
  return unique.length === 1 ? unique[0] : null;
}

const COMPANY_SUFFIXES =
  /\b(?:co|company|corp|corporation|inc|incorporated|limited|ltd|llc)\b/g;

/** Normalizes punctuation and legal suffixes before duplicate-name checks. */
export function normalizeCompanyName(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

/** Returns possible duplicates for review. It never blocks an intentional add. */
export function findSimilarCompanyNames(
  candidate: string,
  existingNames: readonly string[],
) {
  const normalizedCandidate = normalizeCompanyName(candidate);
  if (!normalizedCandidate) return [];

  return existingNames
    .filter((name) => {
      const normalizedExisting = normalizeCompanyName(name);
      if (!normalizedExisting) return false;
      if (normalizedCandidate === normalizedExisting) return true;

      const compactCandidate = normalizedCandidate.replace(/\s/g, "");
      const compactExisting = normalizedExisting.replace(/\s/g, "");
      const shorter = Math.min(compactCandidate.length, compactExisting.length);
      if (
        shorter >= 5 &&
        (compactCandidate.includes(compactExisting) ||
          compactExisting.includes(compactCandidate))
      ) {
        return true;
      }

      const longest = Math.max(compactCandidate.length, compactExisting.length);
      return (
        longest >= 5 &&
        1 - editDistance(compactCandidate, compactExisting) / longest >= 0.82
      );
    })
    .slice(0, 5);
}

/** Builds a new blank tracker row with only COMPANY and CONTACT INFO filled. */
export function buildInKindEntryValues(
  columns: InKindColumns,
  company: string,
  contactInfo: string,
) {
  const values = Array.from(
    { length: Math.max(columns.company, columns.contactInfo) + 1 },
    () => "",
  );
  values[columns.company] = company.trim();
  values[columns.contactInfo] = contactInfo.trim();
  return values;
}

export function columnLetter(index: number) {
  let result = "";
  let n = index;
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

/**
 * The cell writes for one "mark sent" click: request date, status, and who sent
 * it. Three single cells, never a row-wide range — the surrounding columns
 * (NAME, REQUEST, NOTES) are the team's own notes and must survive.
 */
export function buildInKindSentUpdates({
  tabTitle,
  rowNumber,
  columns,
  status,
  contactedBy,
  now,
  gmailMessageId,
}: {
  tabTitle: string;
  rowNumber: number;
  columns: InKindColumns;
  status: string;
  contactedBy: string;
  now: string;
  gmailMessageId?: string;
}): CellUpdate[] {
  if (rowNumber < 2) {
    throw new Error("Row 1 is the header row and must never be written to.");
  }
  if (columns.contactedBy === null) {
    throw new Error(
      "The CONTACTED BY column has not been created yet, so attribution cannot be recorded.",
    );
  }

  const at = (index: number) => `${tabTitle}!${columnLetter(index)}${rowNumber}`;

  const updates = [
    { range: at(columns.dateOfReq), values: [[now]] },
    { range: at(columns.status), values: [[status]] },
    { range: at(columns.contactedBy), values: [[contactedBy]] },
  ];
  if (gmailMessageId) {
    if (columns.gmailMessageId === null) {
      throw new Error(
        "The GMAIL MESSAGE ID column has not been created yet.",
      );
    }
    updates.push({
      range: at(columns.gmailMessageId),
      values: [[gmailMessageId]],
    });
  }
  return updates;
}

/** Subject line for the in-kind ask — the user's own copy, verbatim. */
export const DEFAULT_IN_KIND_SUBJECT = "Example Student Association - In-Kind Sponsorship Request";

/**
 * The user's own in-kind template, supplied verbatim on 2026-08-25. Do not
 * reword it. The only mechanical slots are {company}, {senderName},
 * {senderRole}, {senderRoleIntro}, and {inKindAsk}. OpenRouter selects one
 * approved ask variant for the last slot; code owns every factual statement.
 */
export const DEFAULT_IN_KIND_TEMPLATE = `Hello {company} team,

My name is {senderName}, and I am {senderRoleIntro} at Example Student Association. I am reaching out to seek in-kind sponsorships from {company} to support our upcoming events this year.

Example Student Association is a student-led organization that provides learning opportunities for students interested in the business technology industry. We achieve this through workshops, case competitions, and networking events for our student community.

Our upcoming events include:

- A hands-on workshop for students interested in technology.
- A student case competition.

{inKindAsk}

To express our gratitude, we will acknowledge your support by promoting {company} on our social media and through recognition at our events. We are also open to negotiation if you have alternative or additional proposals.

Please contact me if you are interested in this sponsorship opportunity or if you have any questions.

I look forward to hearing back from you soon!

Kind regards,
{senderName}
{senderRole}, Example Student Association
${MISA_MAILBOX}`;

const IN_KIND_EVENT_WINDOWS: ReadonlyArray<{
  line: string;
  endsAt: number | null;
}> = [
  {
    line: "- A hands-on workshop for students interested in technology.",
    endsAt: null,
  },
  {
    line: "- A student case competition.",
    endsAt: null,
  },
];

/** Removes completed events before a draft reaches OpenRouter or Gmail. */
export function removeCompletedInKindEvents(template: string, now = new Date()) {
  let result = template;

  for (const event of IN_KIND_EVENT_WINDOWS) {
    if (event.endsAt !== null && now.getTime() > event.endsAt) {
      result = result.replace(`${event.line}\n`, "");
    }
  }

  const hasUpcomingEvent = IN_KIND_EVENT_WINDOWS.some(
    (event) =>
      result.includes(event.line) &&
      (event.endsAt === null || now.getTime() <= event.endsAt),
  );
  if (!hasUpcomingEvent) {
    result = result.replace("Our upcoming events include:\n\n", "");
  }

  return result;
}

/** "the Director of Corporate Relations", "a Corporate Relations Coordinator". */
export function roleWithArticle(role: string) {
  return /^director\b/i.test(role.trim()) ? `the ${role}` : `a ${role}`;
}

export function fillInKindTemplate(
  template: string,
  values: {
    company: string;
    senderName: string;
    senderRole: string;
    inKindAsk?: string;
  },
  now = new Date(),
) {
  return removeCompletedInKindEvents(template, now)
    .replaceAll("{company}", values.company)
    .replaceAll("{senderName}", values.senderName)
    .replaceAll("{senderRoleIntro}", roleWithArticle(values.senderRole))
    .replaceAll("{senderRole}", values.senderRole)
    .replaceAll(
      IN_KIND_ASK_SLOT,
      values.inKindAsk ?? DEFAULT_IN_KIND_ASK_PARAGRAPH,
    );
}
