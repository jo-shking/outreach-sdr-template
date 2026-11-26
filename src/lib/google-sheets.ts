import "server-only";

import { stat } from "node:fs/promises";
import { google } from "googleapis";
import { findMonetaryTrackerContact, planMonetaryTrackerWrite, type MonetaryTrackerContact } from "@/lib/monetary-tracker";
import { CONTACTS_TAB } from "@/lib/sheet-writes";

const READ_ONLY_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly";
// The Existing Notes column was deleted from the sheet on 2026-08-23, shifting
// everything after C left by one. This layout must stay in step with the sheet.
// Allow optional Location and Notes columns after the required research fields.
const COMPANIES_RANGE = "Companies!1:1001";

const EXPECTED_HEADERS = [
  "Company ID",
  "Company Name",
  "Website",
  "Priority",
  "Research Status",
  "Alignment Summary",
  "Pitch Angle",
  "Alignment Score",
  "Confidence",
  "Evidence URLs",
  "Last Researched",
] as const;

export type Account = {
  companyId: string | null;
  companyName: string | null;
  website: string | null;
  location?: string | null;
  notes?: string | null;
  priority: string | null;
  researchStatus: string | null;
  alignmentSummary: string | null;
  pitchAngle: string | null;
  alignmentScore: string | null;
  confidence: string | null;
  evidenceUrls: string | null;
  lastResearched: string | null;
};

export class GoogleSheetsConfigurationError extends Error {}
export class GoogleSheetsStructureError extends Error {}

type GoogleSheetsAccessFailure =
  | "credentials_file_missing"
  | "spreadsheet_not_found"
  | "permission_denied"
  | "authentication_failed"
  | "network_error"
  | "upstream_error";

export class GoogleSheetsAccessError extends Error {
  constructor(
    message: string,
    public readonly failure: GoogleSheetsAccessFailure,
    public readonly upstreamStatus?: number,
    public readonly diagnostic?: string,
  ) {
    super(message);
  }
}

function property(value: unknown, name: string) {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, name)
    : undefined;
}

function classifyGoogleSheetsError(error: unknown) {
  const cause = property(error, "cause");
  const code = property(error, "code") ?? property(cause, "code");
  const response = property(error, "response");
  const responseStatus = property(response, "status");
  const directStatus = property(error, "status");
  const status =
    typeof responseStatus === "number"
      ? responseStatus
      : typeof directStatus === "number"
        ? directStatus
        : typeof code === "number"
          ? code
          : undefined;
  const errorMessage = error instanceof Error ? error.message : "";
  const causeMessage = cause instanceof Error ? cause.message : "";
  const message = `${errorMessage} ${causeMessage}`.toLowerCase();

  if (code === "ENOENT" || message.includes("does not exist")) {
    return new GoogleSheetsAccessError(
      "The configured Google service-account JSON file could not be found.",
      "credentials_file_missing",
    );
  }

  if (status === 403) {
    return new GoogleSheetsAccessError(
      "Google denied access to the spreadsheet. Confirm it is shared with the service account and that the Google Sheets API is enabled.",
      "permission_denied",
      status,
    );
  }

  if (status === 404) {
    return new GoogleSheetsAccessError(
      "Google could not find the spreadsheet for this service account. Confirm the spreadsheet ID and share the Sheet with the service-account email.",
      "spreadsheet_not_found",
      status,
    );
  }

  if (
    status === 401 ||
    message.includes("invalid_grant") ||
    message.includes("invalid_client") ||
    message.includes("private key") ||
    message.includes("decoder routines") ||
    message.includes("project id") ||
    message.includes("client_email") ||
    message.includes("credential")
  ) {
    return new GoogleSheetsAccessError(
      "Google rejected the service-account credentials. The JSON key may be invalid, expired, or revoked.",
      "authentication_failed",
      status,
    );
  }

  if (
    message.includes("fetch failed") ||
    message.includes("enotfound") ||
    message.includes("econnreset") ||
    message.includes("unable to verify")
  ) {
    return new GoogleSheetsAccessError(
      "The server could not reach Google Sheets.",
      "network_error",
      status,
    );
  }

  return new GoogleSheetsAccessError(
    "Google Sheets returned an unexpected error.",
    "upstream_error",
    status,
  );
}

function classifyAuthenticationError(error: unknown) {
  const response = property(error, "response");
  const responseData = property(response, "data");
  const remoteError = property(responseData, "error");
  const remoteDescription = property(responseData, "error_description");
  const code = property(error, "code");
  const message = [
    error instanceof Error ? error.message : "",
    typeof remoteError === "string" ? remoteError : "",
    typeof remoteDescription === "string" ? remoteDescription : "",
    typeof code === "string" ? code : "",
  ]
    .join(" ")
    .toLowerCase();

  if (code === "EACCES") {
    return new GoogleSheetsAccessError(
      "The development server was blocked from reaching Google authentication.",
      "network_error",
    );
  }

  if (message.includes("invalid jwt signature")) {
    return new GoogleSheetsAccessError(
      "Google rejected the service-account key signature. The key was likely revoked or no longer matches the service account.",
      "authentication_failed",
    );
  }

  if (
    message.includes("token must be a short-lived token") ||
    message.includes("iat and exp") ||
    message.includes("invalid jwt") && message.includes("time")
  ) {
    return new GoogleSheetsAccessError(
      "Google rejected the credential timestamp. Confirm the computer's date, time, and time zone are correct.",
      "authentication_failed",
    );
  }

  if (
    message.includes("decoder routines") ||
    message.includes("pem routines") ||
    message.includes("private key") ||
    message.includes("asymmetric key")
  ) {
    return new GoogleSheetsAccessError(
      "Google could not use the private key in the JSON file. The key data is malformed or incomplete.",
      "authentication_failed",
    );
  }

  if (
    message.includes("unauthorized_client") ||
    message.includes("account not found") ||
    message.includes("client is unauthorized")
  ) {
    return new GoogleSheetsAccessError(
      "Google does not recognize this JSON as an active, authorized service-account credential.",
      "authentication_failed",
    );
  }

  const errorName = error instanceof Error ? error.name : typeof error;
  const safeCode =
    typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : null;
  const diagnostic = [
    errorName,
    safeCode,
    response ? "with_response" : "without_response",
  ]
    .filter(Boolean)
    .join(":");

  return new GoogleSheetsAccessError(
    "Google rejected the service-account credentials. The JSON key may be invalid, expired, revoked, or not a service-account key.",
    "authentication_failed",
    undefined,
    diagnostic,
  );
}

/**
 * Where the service-account identity comes from. A hosted deployment sets
 * GOOGLE_SERVICE_ACCOUNT_JSON to the key JSON itself (raw or base64), because
 * there is no key file on disk there; local development keeps using the
 * GOOGLE_SERVICE_ACCOUNT_KEY_FILE path. Key material is never logged.
 */
export async function googleAuthOptions(scopes: string[]) {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();

  if (inline) {
    const raw = inline.startsWith("{")
      ? inline
      : Buffer.from(inline, "base64").toString("utf8");

    try {
      return { credentials: JSON.parse(raw), scopes };
    } catch {
      throw new GoogleSheetsConfigurationError(
        "GOOGLE_SERVICE_ACCOUNT_JSON is set but does not contain valid JSON (raw or base64).",
      );
    }
  }

  const keyFile = requireServerEnvironment("GOOGLE_SERVICE_ACCOUNT_KEY_FILE");

  try {
    const keyFileDetails = await stat(keyFile);
    if (!keyFileDetails.isFile()) {
      throw new GoogleSheetsAccessError(
        "The configured Google service-account JSON path is not a file.",
        "credentials_file_missing",
      );
    }
  } catch (error) {
    if (error instanceof GoogleSheetsAccessError) throw error;
    throw new GoogleSheetsAccessError(
      "The Google service-account key file was not found.",
      "credentials_file_missing",
    );
  }

  return { keyFile, scopes };
}

async function readCompanyValues({ spreadsheetId }: { spreadsheetId: string }) {
  const auth = new google.auth.GoogleAuth(
    await googleAuthOptions([READ_ONLY_SCOPE]),
  );

  try {
    await auth.getAccessToken();
  } catch (error) {
    throw classifyAuthenticationError(error);
  }

  try {
    const sheets = google.sheets({ version: "v4", auth });

    return await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: COMPANIES_RANGE,
      valueRenderOption: "FORMATTED_VALUE",
    });
  } catch (error) {
    throw classifyGoogleSheetsError(error);
  }
}

function requireServerEnvironment(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new GoogleSheetsConfigurationError(
      `${name} is not configured on the server.`,
    );
  }

  return value;
}

function cellValue(row: unknown[], index: number) {
  const value = row[index];

  if (value === undefined || value === null || value === "") return null;
  return String(value).trim() || null;
}

function headersMatch(row: unknown[]) {
  return EXPECTED_HEADERS.every(
    (header, index) => cellValue(row, index) === header,
  );
}

export async function getAccounts(): Promise<Account[]> {
  const spreadsheetId = requireServerEnvironment("GOOGLE_SPREADSHEET_ID");

  const response = await readCompanyValues({ spreadsheetId });
  const rows = response.data.values ?? [];

  if (!rows[0] || !headersMatch(rows[0])) {
    throw new GoogleSheetsStructureError(
      "The Companies header row does not match the expected structure.",
    );
  }

  const locationColumn = rows[0].findIndex((value, index) =>
    index >= EXPECTED_HEADERS.length && /^(?:company )?location$/i.test(String(value).trim()),
  );
  const notesColumn = rows[0].findIndex((value, index) =>
    index >= EXPECTED_HEADERS.length && /^(?:(?:company|existing|tracker) )?notes$/i.test(String(value).trim()),
  );
  return rows.slice(1).flatMap((row) => {
    if (!row.slice(0, EXPECTED_HEADERS.length).some((value) => String(value).trim())) return [];

    return [
      {
        companyId: cellValue(row, 0),
        companyName: cellValue(row, 1),
        website: cellValue(row, 2),
        location: locationColumn >= 0 ? cellValue(row, locationColumn) : null,
        notes: notesColumn >= 0 ? cellValue(row, notesColumn) : null,
        priority: cellValue(row, 3),
        researchStatus: cellValue(row, 4),
        alignmentSummary: cellValue(row, 5),
        pitchAngle: cellValue(row, 6),
        alignmentScore: cellValue(row, 7),
        confidence: cellValue(row, 8),
        evidenceUrls: cellValue(row, 9),
        lastResearched: cellValue(row, 10),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Write-back
//
// The read path above deliberately used a read-only scope. Writing needs the
// broader "spreadsheets" scope, which also grants write access to every other
// sheet this service account can see — so every write below names an explicit
// range, and Sheet1 (the user's own tracker) is never a target.
// ---------------------------------------------------------------------------

const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const CONTACTS_ID_RANGE = "Contacts!A1:A1001";

async function writableSheets() {
  const spreadsheetId = requireServerEnvironment("GOOGLE_SPREADSHEET_ID");

  const auth = new google.auth.GoogleAuth(
    await googleAuthOptions([WRITE_SCOPE]),
  );

  try {
    await auth.getAccessToken();
  } catch (error) {
    throw classifyAuthenticationError(error);
  }

  return {
    sheets: google.sheets({ version: "v4", auth }),
    spreadsheetId,
  };
}

export async function prepareMonetaryTrackerSend(contact: MonetaryTrackerContact) {
  const { sheets, spreadsheetId } = await writableSheets();
  async function readContacts() {
    return (await sheets.spreadsheets.values.get({
      spreadsheetId, range: CONTACTS_TAB, valueRenderOption: "FORMULA",
    })).data.values ?? [];
  }
  const { alreadyContacted } = findMonetaryTrackerContact(await readContacts(), contact);

  return {
    alreadyContacted,
    async record(send: { senderName: string; date: string; messageId: string }) {
      // Recheck the layout and resolve the row again after SMTP returns.
      const plan = planMonetaryTrackerWrite(await readContacts(), contact, send);
      if (plan.recorded) return;
      if (!plan.updates.length && !plan.append) throw new Error("A different send is already recorded for this recipient.");
      const { hasMessageColumn, messageColumn } = plan;
      if (!hasMessageColumn) {
        const metadata = await sheets.spreadsheets.get({
          spreadsheetId, fields: "sheets(properties(sheetId,title,gridProperties(columnCount))",
        });
        const tab = metadata.data.sheets?.find(({ properties }) => properties?.title === CONTACTS_TAB)?.properties;
        if (tab?.sheetId == null || !tab.gridProperties?.columnCount) {
          throw new Error("The Contacts tab grid could not be read.");
        }
        if (messageColumn >= tab.gridProperties.columnCount) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ appendDimension: {
              sheetId: tab.sheetId, dimension: "COLUMNS", length: messageColumn + 1 - tab.gridProperties.columnCount,
            } }] },
          });
        }
      }
      if (plan.updates.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId, requestBody: { valueInputOption: "RAW", data: plan.updates },
        });
      }
      if (plan.append) {
        const result = await sheets.spreadsheets.values.append({
          spreadsheetId, range: `${CONTACTS_TAB}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
          requestBody: { values: [plan.append] },
        });
        if (result.data.updates?.updatedRows !== 1) throw new Error("The contact row was not recorded.");
      }
    },
  };
}

/** The Company ID and Name of every row, for locating the row to write to. */
export async function getCompanyRowKeys(): Promise<
  Array<{
    companyId: string | null;
    companyName: string | null;
    website: string | null;
  }>
> {
  const { sheets, spreadsheetId } = await writableSheets();

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Companies!A2:C1001",
      valueRenderOption: "FORMATTED_VALUE",
    });

    return (response.data.values ?? []).map((row) => ({
      companyId: cellValue(row, 0),
      companyName: cellValue(row, 1),
      website: cellValue(row, 2),
    }));
  } catch (error) {
    throw classifyGoogleSheetsError(error);
  }
}

/** Applies a set of explicit cell writes in one request. */
export async function applyCellUpdates(
  updates: ReadonlyArray<{ range: string; values: string[][] }>,
): Promise<number> {
  if (updates.length === 0) return 0;

  for (const update of updates) {
    // A defence in depth: the caller builds these ranges, but a bug that pointed
    // one at the user's own tracker would be unrecoverable.
    if (update.range.startsWith("Sheet1")) {
      throw new GoogleSheetsConfigurationError(
        "Sheet1 is the user's own tracker and must never be written to.",
      );
    }
  }

  const { sheets, spreadsheetId } = await writableSheets();

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

    return response.data.totalUpdatedCells ?? 0;
  } catch (error) {
    throw classifyGoogleSheetsError(error);
  }
}

/** Existing Contact IDs, so re-recording a contact updates rather than duplicates. */
export async function getContactIds(): Promise<string[]> {
  const { sheets, spreadsheetId } = await writableSheets();

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: CONTACTS_ID_RANGE,
      valueRenderOption: "FORMATTED_VALUE",
    });

    // Row 1 is the header, so drop it and keep positional alignment.
    return (response.data.values ?? []).slice(1).map((row) => String(row[0] ?? ""));
  } catch (error) {
    throw classifyGoogleSheetsError(error);
  }
}

/**
 * Appends rows to a tab, letting Sheets pick the next empty row. The tab list
 * is a deliberate whitelist: only tabs the app owns, never Sheet1.
 */
export async function appendRows(
  tab: "Contacts" | "Follow-ups" | "Sponsors",
  rows: ReadonlyArray<string[]>,
): Promise<number> {
  if (rows.length === 0) return 0;

  const { sheets, spreadsheetId } = await writableSheets();

  try {
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows.map((row) => [...row]) },
    });

    return response.data.updates?.updatedRows ?? 0;
  } catch (error) {
    throw classifyGoogleSheetsError(error);
  }
}

/** Replaces the Contacts header row with the agreed 12-column layout. */
export async function setContactsHeader(headers: readonly string[]): Promise<void> {
  await applyCellUpdates([
    { range: `Contacts!A1:${String.fromCharCode(64 + headers.length)}1`, values: [[...headers]] },
  ]);
}

export type RecordedContact = {
  contactId: string;
  companyId: string;
  companyName: string;
  name: string;
  title: string;
  workEmail: string;
  linkedinUrl: string;
  isAlum: boolean;
  outreachStatus: string;
  channel: string;
  reachedOutBy: string;
  dateReachedOut: string;
  dateFollowedUp: string;
};

/**
 * Every contact already recorded in the sheet. With several people sharing one mailbox
 * this is what stops two of them approaching the same company: the UI shows who has
 * already been contacted, by whom, and when.
 */
export async function getRecordedContacts(): Promise<RecordedContact[]> {
  const { sheets, spreadsheetId } = await writableSheets();

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Contacts!A2:M1001",
      valueRenderOption: "FORMATTED_VALUE",
    });

    return (response.data.values ?? [])
      .filter((row) => String(row[0] ?? "").trim())
      .map((row) => ({
        contactId: cellValue(row, 0) ?? "",
        companyId: cellValue(row, 1) ?? "",
        companyName: cellValue(row, 2) ?? "",
        name: cellValue(row, 3) ?? "",
        title: cellValue(row, 4) ?? "",
        workEmail: cellValue(row, 5) ?? "",
        linkedinUrl: cellValue(row, 6) ?? "",
        isAlum: (cellValue(row, 7) ?? "").toLowerCase() === "yes",
        outreachStatus: cellValue(row, 8) ?? "",
        channel: cellValue(row, 9) ?? "",
        reachedOutBy: cellValue(row, 10) ?? "",
        dateReachedOut: cellValue(row, 11) ?? "",
        dateFollowedUp: cellValue(row, 12) ?? "",
      }));
  } catch (error) {
    throw classifyGoogleSheetsError(error);
  }
}
