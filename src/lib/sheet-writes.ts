// Builds the exact cell updates a write-back performs. Kept pure so the addressing can be
// unit tested: a wrong range here would overwrite live rows in a tracker whose only undo
// is Google's version history.
//
// Sheet1 is the user's original tracker and is never read or written by this module.
//
// Companies (existing headers, live data; Existing Notes was deleted 2026-08-23):
//   A Company ID | B Name | C Website | D Priority | E Research Status
//   F Alignment Summary | G Pitch Angle | H Alignment Score | I Confidence
//   J Evidence URLs | K Last Researched
// F, G and J hold long prose that makes the sheet unreadable, so research writes skip
// them; the full summary and pitch live in the agent's own research cache instead.

export type CellUpdate = {
  range: string;
  values: string[][];
};

export const COMPANIES_TAB = "Companies";
export const CONTACTS_TAB = "Contacts";

/** The Contacts tab layout, replacing the unused original headers. */
export const CONTACTS_HEADERS = [
  "Contact ID",
  "Company ID",
  "Company Name",
  "Contact Name",
  "Job Title",
  "Work Email",
  "LinkedIn URL",
  "SFU/MISA Alum",
  "Outreach Status",
  "Channel",
  // Attribution. Filled from the Sender name field in the app, so with several people
  // sharing one MISA mailbox it stays clear who actually made contact.
  "Reached Out By",
  "Date Reached Out",
  "Date Followed Up",
] as const;

/** Allowed Outreach Status values, for a data-validation dropdown on column I. */
export const OUTREACH_STATUSES = [
  "Not started",
  "Email sent",
  "LinkedIn sent",
  "Replied",
  "Meeting booked",
  "No response",
  "Not a fit",
] as const;

export const ALUM_VALUES = ["Yes", "No"] as const;
export const CHANNEL_VALUES = ["Email", "LinkedIn"] as const;

function text(value: unknown, maxLength = 45_000) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * A stable id for a company row, derived from the name so re-running is idempotent: the
 * same account always gets the same id, and Contacts rows keep pointing at the right
 * company even if rows are reordered.
 */
export function companyIdFor(companyName: string) {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `C-${slug}` : "";
}

export function contactIdFor(
  companyId: string,
  linkedinUrl: string | null,
  name: string,
) {
  const suffix = linkedinUrl
    ? (linkedinUrl.match(/\/in\/([^/?#]+)/i)?.[1] ?? name)
    : name;
  const slug = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `${companyId}:${slug}` : "";
}

/**
 * Research results for one account: the short, scannable fields only. Writes E, H, I and
 * K as separate ranges rather than one E–K block, because a contiguous write would blank
 * the prose columns F, G and J that the sheet keeps for manual notes.
 */
export function buildResearchUpdates({
  rowNumber,
  existingCompanyId,
  existingWebsite,
  inferredWebsite,
  companyName,
  research,
  now,
}: {
  rowNumber: number;
  existingCompanyId: string | null;
  /** What the Website cell already holds; a human-entered value is never overwritten. */
  existingWebsite: string | null;
  /** Domain inferred from research sources, used only to fill a blank Website cell. */
  inferredWebsite: string | null;
  companyName: string;
  research: {
    alignmentSummary: string | null;
    companyOverview: string | null;
    fitScore: number;
    confidenceScore: number;
  };
  now: string;
}): CellUpdate[] {
  if (rowNumber < 2) {
    throw new Error("Row 1 is the header row and must never be written to.");
  }

  const updates: CellUpdate[] = [];

  // Only fill the id when it is missing; never renumber a row a human already keyed.
  if (!existingCompanyId) {
    const generated = companyIdFor(companyName);
    if (generated) {
      updates.push({
        range: `${COMPANIES_TAB}!A${rowNumber}`,
        values: [[generated]],
      });
    }
  }

  // Same rule as the id: fill a blank Website from the researched domain, but a value
  // a human typed stays exactly as they typed it.
  if (!existingWebsite && inferredWebsite) {
    updates.push({
      range: `${COMPANIES_TAB}!C${rowNumber}`,
      values: [[text(inferredWebsite, 200)]],
    });
  }

  updates.push({
    range: `${COMPANIES_TAB}!E${rowNumber}`,
    values: [
      [
        research.alignmentSummary || research.companyOverview
          ? "Researched"
          : "Researched - no synthesis",
      ],
    ],
  });
  updates.push({
    range: `${COMPANIES_TAB}!H${rowNumber}:I${rowNumber}`,
    values: [[number(research.fitScore), number(research.confidenceScore)]],
  });
  updates.push({
    range: `${COMPANIES_TAB}!K${rowNumber}`,
    values: [[now]],
  });

  return updates;
}

export type ContactRow = {
  contactId: string;
  companyId: string;
  companyName: string;
  name: string;
  title: string;
  workEmail: string;
  linkedinUrl: string;
  isAlum: boolean;
  outreachStatus: (typeof OUTREACH_STATUSES)[number];
  channel: "" | (typeof CHANNEL_VALUES)[number];
  reachedOutBy: string;
  dateReachedOut: string;
  dateFollowedUp: string;
};

/** A Contacts row in column order, ready to append or update. */
export function buildContactRow(row: ContactRow): string[] {
  return [
    row.contactId,
    row.companyId,
    row.companyName,
    row.name,
    row.title,
    row.workEmail,
    row.linkedinUrl,
    row.isAlum ? "Yes" : "No",
    row.outreachStatus,
    row.channel,
    row.reachedOutBy,
    row.dateReachedOut,
    row.dateFollowedUp,
  ].map((value) => text(value));
}

/**
 * Locates an account's row from a freshly read Companies column. Matching happens on the
 * id when one exists and on the name otherwise, and an ambiguous name is refused rather
 * than guessed — writing research onto the wrong company is worse than not writing it.
 */
export function findCompanyRow({
  rows,
  companyName,
  companyId,
}: {
  rows: ReadonlyArray<{
    companyId: string | null;
    companyName: string | null;
    website?: string | null;
  }>;
  companyName: string;
  companyId: string | null;
}): {
  rowNumber: number;
  existingCompanyId: string | null;
  existingWebsite: string | null;
} {
  const wanted = companyName.trim().toLowerCase();

  if (companyId) {
    const index = rows.findIndex((row) => row.companyId === companyId);
    if (index !== -1) {
      // rows[0] is spreadsheet row 2, because row 1 is the header.
      return {
        rowNumber: index + 2,
        existingCompanyId: rows[index].companyId,
        existingWebsite: rows[index].website ?? null,
      };
    }
  }

  const matches = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (row.companyName ?? "").trim().toLowerCase() === wanted);

  if (matches.length === 0) {
    throw new Error(
      `"${companyName}" was not found in the Companies tab, so there is no row to write to.`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `"${companyName}" appears on ${matches.length} rows of the Companies tab. Give those rows distinct Company IDs before writing, so the research lands on the intended one.`,
    );
  }

  return {
    rowNumber: matches[0].index + 2,
    existingCompanyId: matches[0].row.companyId,
    existingWebsite: matches[0].row.website ?? null,
  };
}

/**
 * Finds an existing Contacts row for a contact id, so re-recording the same person
 * updates their row instead of appending a duplicate.
 */
export function findContactRow(
  contactIds: readonly string[],
  contactId: string,
): number | null {
  const index = contactIds.findIndex((value) => value.trim() === contactId);
  return index === -1 ? null : index + 2;
}

/**
 * Rewrites an existing Contacts row in place. Used when a contact id is already present,
 * so recording the same person twice updates their row rather than appending a duplicate.
 */
export function buildContactRowUpdate(
  rowNumber: number,
  row: ContactRow,
): CellUpdate {
  if (rowNumber < 2) {
    throw new Error("Row 1 is the header row and must never be written to.");
  }

  const lastColumn = String.fromCharCode(64 + CONTACTS_HEADERS.length);
  return {
    range: `${CONTACTS_TAB}!A${rowNumber}:${lastColumn}${rowNumber}`,
    values: [buildContactRow(row)],
  };
}

/**
 * The corporate-relations team, used for the `Reached Out By` dropdown and for the
 * sender picker in the UI. Keeping one list means attribution values in the sheet cannot
 * drift across spelling variations, which would break filtering by person.
 *
 * Add team members here once so every dropdown and draft signature stays aligned.
 */
export const TEAM_MEMBERS = [
  { name: "Alex Example", role: "Director of Corporate Relations" },
  { name: "Jordan Example", role: "Corporate Relations Coordinator" },
  { name: "Taylor Example", role: "Corporate Relations Coordinator" },
  { name: "Morgan Example", role: "Corporate Relations Coordinator" },
  { name: "Casey Example", role: "Corporate Relations Coordinator" },
  { name: "Jamie Example", role: "Corporate Relations Coordinator" },
] as const;

export const TEAM_NAMES = TEAM_MEMBERS.map((member) => member.name);
