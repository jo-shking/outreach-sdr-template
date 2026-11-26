import "server-only";

import { google } from "googleapis";

import {
  appendRows,
  applyCellUpdates,
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
  googleAuthOptions,
} from "./google-sheets";
import {
  buildFollowUpRow,
  buildSponsorRow,
  FOLLOW_UPS_HEADERS,
  FOLLOW_UPS_TAB,
  mapFollowUpRows,
  mapSponsorRows,
  SPONSORS_HEADERS,
  SPONSORS_TAB,
  type FollowUpRow,
  type SponsorRow,
} from "./follow-ups";

// Both tabs live in the app's own tracker spreadsheet. They are created on
// first use; Sheet1 is never touched (the shared write layer enforces that).

const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function requireSpreadsheetId() {
  const value = process.env.GOOGLE_SPREADSHEET_ID?.trim();
  if (!value) {
    throw new GoogleSheetsConfigurationError(
      "GOOGLE_SPREADSHEET_ID is not configured on the server.",
    );
  }
  return value;
}

async function sheetsClient() {
  const auth = new google.auth.GoogleAuth(
    await googleAuthOptions([WRITE_SCOPE]),
  );
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId: requireSpreadsheetId() };
}

type ColumnFormat = {
  /** 0-based column index. */
  column: number;
  type: "DATE" | "CURRENCY";
  pattern: string;
};

// Without explicit formats, a date written into a brand-new API-created tab
// can display as a raw serial number like 46269. These pin the display.
const FOLLOW_UPS_FORMATS: ColumnFormat[] = [
  { column: 1, type: "DATE", pattern: "yyyy-mm-dd" }, // Expected Reply
  { column: 4, type: "DATE", pattern: "yyyy-mm-dd" }, // Added On
  { column: 6, type: "DATE", pattern: "yyyy-mm-dd" }, // Reminded On
];
const SPONSORS_FORMATS: ColumnFormat[] = [
  { column: 1, type: "CURRENCY", pattern: "$#,##0.00" }, // Amount
  { column: 2, type: "DATE", pattern: "yyyy-mm-dd" }, // Date
];

/** Formats the data rows of the given columns so dates never show as serials. */
export async function applyColumnFormats(tab: string, formats: ColumnFormat[]) {
  const { sheets, spreadsheetId } = await sheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId = meta.data.sheets?.find(
    (sheet) => sheet.properties?.title === tab,
  )?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: formats.map((format) => ({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: 1000,
            startColumnIndex: format.column,
            endColumnIndex: format.column + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: format.type, pattern: format.pattern },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      })),
    },
  });
}

/** Creates a tab with its header row and column formats when it does not exist yet. */
async function ensureTab(
  tab: string,
  headers: readonly string[],
  formats: ColumnFormat[],
) {
  const { sheets, spreadsheetId } = await sheetsClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(
    (sheet) => sheet.properties?.title === tab,
  );
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: tab,
              gridProperties: { rowCount: 1000, columnCount: headers.length },
            },
          },
        },
      ],
    },
  });
  await applyCellUpdates([
    {
      range: `${tab}!A1:${String.fromCharCode(64 + headers.length)}1`,
      values: [[...headers]],
    },
  ]);
  await applyColumnFormats(tab, formats);
}

async function readRows(tab: string, lastColumn: string) {
  const { sheets, spreadsheetId } = await sheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:${lastColumn}1001`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return response.data.values ?? [];
}

export async function listFollowUps(): Promise<FollowUpRow[]> {
  await ensureTab(FOLLOW_UPS_TAB, FOLLOW_UPS_HEADERS, FOLLOW_UPS_FORMATS);
  return mapFollowUpRows(await readRows(FOLLOW_UPS_TAB, "G"));
}

export async function addFollowUp(input: {
  company: string;
  expectedReply: string;
  note: string;
  addedBy: string;
  addedOn: string;
}): Promise<void> {
  await ensureTab(FOLLOW_UPS_TAB, FOLLOW_UPS_HEADERS, FOLLOW_UPS_FORMATS);
  await appendRows(FOLLOW_UPS_TAB, [buildFollowUpRow(input)]);
}

/**
 * Flips one follow-up to "Heard back". The row's company is re-checked right
 * before the write, so a row that moved is refused rather than overwritten.
 */
export async function markHeardBack({
  rowNumber,
  company,
}: {
  rowNumber: number;
  company: string;
}): Promise<void> {
  if (rowNumber < 2) {
    throw new Error("Row 1 is the header row and must never be written to.");
  }

  const rows = await readRows(FOLLOW_UPS_TAB, "G");
  const current = String(rows[rowNumber - 2]?.[0] ?? "").trim();
  if (!current || current !== company.trim()) {
    throw new GoogleSheetsAccessError(
      `Row ${rowNumber} no longer holds "${company}" — refresh and try again.`,
      "spreadsheet_not_found",
    );
  }

  await applyCellUpdates([
    { range: `${FOLLOW_UPS_TAB}!F${rowNumber}`, values: [["Heard back"]] },
  ]);
}

export async function listSponsors(): Promise<SponsorRow[]> {
  await ensureTab(SPONSORS_TAB, SPONSORS_HEADERS, SPONSORS_FORMATS);
  return mapSponsorRows(await readRows(SPONSORS_TAB, "D"));
}

export async function addSponsor(input: {
  sponsor: string;
  amount: number;
  date: string;
  addedBy: string;
}): Promise<void> {
  await ensureTab(SPONSORS_TAB, SPONSORS_HEADERS, SPONSORS_FORMATS);
  await appendRows(SPONSORS_TAB, [buildSponsorRow(input)]);
}
