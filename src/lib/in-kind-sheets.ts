import "server-only";

import { createHash } from "node:crypto";
import { google } from "googleapis";
import {
  buildInKindFollowUpDraft, buildInKindFollowUpQueues, findFollowUpSentColumn,
  FOLLOW_UP_SENT_HEADER, vancouverDate,
} from "./in-kind-follow-ups";

import {
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
  googleAuthOptions,
} from "./google-sheets";
import {
  buildInKindEntryValues,
  buildInKindSentUpdates,
  columnLetter,
  findSimilarCompanyNames,
  findInKindColumns,
  mapInKindRows,
  type InKindColumns,
  type InKindRow,
} from "./in-kind";

// The in-kind list lives in the shared "Master Outreach Tracker" — someone
// else's spreadsheet. Everything here is defensive: the tab is resolved by its
// gid (rename-proof), columns are located by header text, and every write
// names a single cell in that one tab. No other tab of that spreadsheet is
// ever read or written.

const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new GoogleSheetsConfigurationError(
      `${name} is not configured on the server.`,
    );
  }
  return value;
}

async function inKindSheets() {
  const spreadsheetId = requireEnv("IN_KIND_SPREADSHEET_ID");
  const tabGid = Number(requireEnv("IN_KIND_TAB_GID"));

  const auth = new google.auth.GoogleAuth(
    await googleAuthOptions([WRITE_SCOPE]),
  );
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId, tabGid };
}

function translateError(error: unknown): Error {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : null;

  if (status === 403 || status === 404) {
    return new GoogleSheetsAccessError(
      "The Master Outreach Tracker is not accessible. Share it with the service account (Editor) and try again.",
      "permission_denied",
    );
  }

  return error instanceof Error
    ? error
    : new Error("The in-kind sheet request failed.");
}

async function resolveTab() {
  const { sheets, spreadsheetId, tabGid } = await inKindSheets();

  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId });
  } catch (error) {
    throw translateError(error);
  }

  const tab = meta.data.sheets?.find(
    (sheet) => sheet.properties?.sheetId === tabGid,
  );
  if (!tab?.properties?.title) {
    throw new GoogleSheetsAccessError(
      "The configured in-kind tab was not found in the Master Outreach Tracker.",
      "spreadsheet_not_found",
    );
  }

  return { sheets, spreadsheetId, tabTitle: tab.properties.title, tabGid,
    columnCount: tab.properties.gridProperties?.columnCount ?? 26 };
}

async function readTab(
  valueRenderOption: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" = "FORMATTED_VALUE",
  fullWidth = false,
) {
  const { sheets, spreadsheetId, tabTitle, tabGid, columnCount } = await resolveTab();

  let response;
  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: fullWidth ? `${quoteTab(tabTitle)}!A1:${columnLetter(columnCount - 1)}` : `${tabTitle}!A1:Z1001`,
      valueRenderOption,
    });
  } catch (error) {
    throw translateError(error);
  }

  const allRows = response.data.values ?? [];
  const header = (allRows[0] ?? []).map((value) => String(value ?? ""));
  return { sheets, spreadsheetId, tabTitle, tabGid, columnCount, header, dataRows: allRows.slice(1) };
}

function quoteTab(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Read-only input for follow-ups; date cells come back as ISO text or Sheets serials. */
export async function getInKindFollowUpSource() {
  const { header, dataRows } = await readTab("UNFORMATTED_VALUE", true);
  return { columns: findInKindColumns(header), dataRows, completedColumn: findFollowUpSentColumn(header) };
}

export function followUpReviewId(rows: ReadonlyArray<readonly unknown[]>,
  columns: InKindColumns, rowNumber: number, to: string) {
  const original = columns.gmailMessageId === null ? "" :
    String(rows[rowNumber - 2]?.[columns.gmailMessageId] ?? "").trim();
  return original ? createHash("sha256").update(JSON.stringify([original, to])).digest("hex") : null;
}

/** Records the coordinator's confirmation; this never calls Gmail. */
export async function markInKindFollowUpSent(input: {
  rowNumber: number; company: string; reviewId: string; teamNames: readonly string[];
}) {
  const { sheets, spreadsheetId, tabGid, columnCount, header, dataRows } =
    await readTab("UNFORMATTED_VALUE", true);
  const columns = findInKindColumns(header);
  const completedColumn = findFollowUpSentColumn(header);
  const today = vancouverDate();
  const queues = buildInKindFollowUpQueues(dataRows, columns, input.teamNames, today, completedColumn);
  const draft = buildInKindFollowUpDraft(queues, dataRows, columns, input.rowNumber, input.company);
  if (!draft || followUpReviewId(dataRows, columns, input.rowNumber, draft.to) !== input.reviewId) return false;

  // Add a dedicated column after all existing data; never reuse a gap in the tracker.
  const col = completedColumn >= 0 ? completedColumn : Math.max(header.length, ...dataRows.map(row => row.length));
  const sheetCell = (rowIndex: number, value: string) => ({
    updateCells: {
      start: { sheetId: tabGid, rowIndex, columnIndex: col },
      rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
      fields: "userEnteredValue",
    },
  });
  const requests = [];
  if (col >= columnCount) {
    requests.push({ appendDimension: { sheetId: tabGid, dimension: "COLUMNS", length: col - columnCount + 1 } });
  }
  if (completedColumn < 0) requests.push(sheetCell(0, FOLLOW_UP_SENT_HEADER));
  requests.push(sheetCell(input.rowNumber - 1, today));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return true;
}

async function ensureColumn({
  sheets,
  spreadsheetId,
  tabTitle,
  header,
  name,
}: {
  sheets: Awaited<ReturnType<typeof inKindSheets>>["sheets"];
  spreadsheetId: string;
  tabTitle: string;
  header: string[];
  name: string;
}) {
  const existing = header.findIndex(
    (cell) => cell.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing !== -1) return existing;

  const firstBlank = header.findIndex((cell) => !cell.trim());
  const index = firstBlank === -1 ? header.length : firstBlank;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabTitle}!${columnLetter(index)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[name]] },
    });
  } catch (error) {
    throw translateError(error);
  }
  return index;
}

export type InKindList = {
  tabTitle: string;
  rows: InKindRow[];
};

export type AddInKindCompanyResult = {
  added: boolean;
  tabTitle: string;
  similarCompanies: string[];
};

/**
 * The in-kind rows, creating the CONTACTED BY column the first time — the
 * shared tab has no attribution column, and a team of four needs one.
 */
export async function getInKindList(): Promise<InKindList> {
  const { sheets, spreadsheetId, tabTitle, header, dataRows } = await readTab();
  let columns = findInKindColumns(header);

  if (columns.contactedBy === null) {
    const index = await ensureColumn({
      sheets,
      spreadsheetId,
      tabTitle,
      header,
      name: "CONTACTED BY",
    });
    columns = { ...columns, contactedBy: index };
  }

  return { tabTitle, rows: mapInKindRows(dataRows, columns) };
}

/** Checks for possible duplicates, then appends only the submitted company and email. */
export async function addInKindCompany({
  company,
  contactInfo,
  confirmSimilar,
}: {
  company: string;
  contactInfo: string;
  confirmSimilar: boolean;
}): Promise<AddInKindCompanyResult> {
  const { sheets, spreadsheetId, tabTitle, header, dataRows } = await readTab();
  const columns = findInKindColumns(header);
  const existingRows = mapInKindRows(dataRows, columns);
  const similarCompanies = findSimilarCompanyNames(
    company,
    existingRows.map((row) => row.company),
  );

  if (similarCompanies.length > 0 && !confirmSimilar) {
    return { added: false, tabTitle, similarCompanies };
  }

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabTitle}!A:Z`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [buildInKindEntryValues(columns, company, contactInfo)],
      },
    });
    return { added: true, tabTitle, similarCompanies };
  } catch (error) {
    throw translateError(error);
  }
}

/**
 * Records one send: request date, status, attribution. The row's company is
 * re-checked immediately before writing, so a row that moved since the page
 * loaded is refused rather than silently overwritten.
 */
export async function markInKindSent({
  rowNumber,
  company,
  status,
  contactedBy,
  now,
  gmailMessageId,
}: {
  rowNumber: number;
  company: string;
  status: string;
  contactedBy: string;
  now: string;
  gmailMessageId?: string;
}): Promise<{ tabTitle: string; cells: number }> {
  const { sheets, spreadsheetId, tabTitle, header, dataRows } = await readTab();
  let columns: InKindColumns = findInKindColumns(header);

  if (columns.contactedBy === null) {
    throw new GoogleSheetsAccessError(
      "The CONTACTED BY column is missing. Load the in-kind list once to create it.",
      "spreadsheet_not_found",
    );
  }

  if (gmailMessageId && columns.gmailMessageId === null) {
    const index = await ensureColumn({
      sheets,
      spreadsheetId,
      tabTitle,
      header,
      name: "GMAIL MESSAGE ID",
    });
    columns = { ...columns, gmailMessageId: index };
  }

  const row = dataRows[rowNumber - 2];
  const currentCompany = String(row?.[columns.company] ?? "").trim();
  if (!currentCompany || currentCompany !== company.trim()) {
    throw new GoogleSheetsAccessError(
      `Row ${rowNumber} no longer holds "${company}" — the sheet changed since the list loaded. Refresh and try again.`,
      "spreadsheet_not_found",
    );
  }

  const updates = buildInKindSentUpdates({
    tabTitle,
    rowNumber,
    columns,
    status,
    contactedBy,
    now,
    gmailMessageId,
  });

  // Defence in depth: every write must stay inside the resolved in-kind tab.
  for (const update of updates) {
    if (!update.range.startsWith(`${tabTitle}!`)) {
      throw new Error(`Refusing to write outside the in-kind tab: ${update.range}`);
    }
  }

  try {
    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates.map((update) => ({
          range: update.range,
          values: update.values,
        })),
      },
    });
    return {
      tabTitle,
      cells: response.data.totalUpdatedCells ?? 0,
    };
  } catch (error) {
    throw translateError(error);
  }
}
