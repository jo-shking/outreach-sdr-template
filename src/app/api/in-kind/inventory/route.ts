import "server-only";

import { google } from "googleapis";
import { googleAuthOptions } from "@/lib/google-sheets";
import { summarizeInKindInventory } from "@/lib/in-kind-inventory";

const INVENTORY_SPREADSHEET_ID = process.env.IN_KIND_INVENTORY_SPREADSHEET_ID?.trim();
const INVENTORY_RANGE = "'In-Kind Inventory'!A:D";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  if (!INVENTORY_SPREADSHEET_ID) {
    return Response.json({ error: "In-kind inventory is not configured." }, { status: 503, headers });
  }
  try {
    const auth = new google.auth.GoogleAuth(await googleAuthOptions([
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ]));
    const sheets = google.sheets({ version: "v4", auth });
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: INVENTORY_SPREADSHEET_ID,
      range: INVENTORY_RANGE,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    return Response.json(summarizeInKindInventory(data.values ?? []), { headers });
  } catch {
    return Response.json(
      { error: "Could not read the in-kind inventory values." },
      { status: 502, headers },
    );
  }
}
