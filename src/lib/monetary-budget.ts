import "server-only";

import { createHash } from "node:crypto";
import { google } from "googleapis";
import { googleAuthOptions } from "./google-sheets";

const CAP = { Apify: 20, Clay: 4 } as const;

/** Non-resetting pilot budget shared across deployments and team members. */
export async function reserveMonetaryLookup(provider: keyof typeof CAP) {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID?.trim();
  if (!spreadsheetId) throw new Error("Monetary budget is unavailable.");
  const auth = new google.auth.GoogleAuth(await googleAuthOptions([
    "https://www.googleapis.com/auth/spreadsheets",
  ]));
  const sheets = google.sheets({ version: "v4", auth });
  const metadataKey = `misa_monetary_pilot_v1_${provider.toLowerCase()}`;
  const { data } = await sheets.spreadsheets.developerMetadata.search({
    spreadsheetId,
    requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey } }] },
  });
  const used = new Set((data.matchedDeveloperMetadata ?? []).map(
    (entry) => entry.developerMetadata?.metadataValue,
  ));
  for (let slot = 1; slot <= CAP[provider]; slot++) {
    if (used.has(String(slot))) continue;
    const digest = createHash("sha256").update(`${metadataKey}:${slot}`).digest();
    const metadataId = (digest.readUInt32BE() & 0x7fffffff) || 1;
    // Sheets refuses a duplicate ID, so simultaneous requests cannot both spend a slot.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ createDeveloperMetadata: { developerMetadata: {
        metadataId, metadataKey, metadataValue: String(slot),
        visibility: "PROJECT", location: { spreadsheet: true },
      } } }] },
    });
    return true;
  }
  return false;
}
