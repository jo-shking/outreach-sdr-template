import "server-only";

import {
  getRecordedContacts,
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
} from "@/lib/google-sheets";

/**
 * Returns every contact already recorded in the sheet, optionally narrowed to one
 * company. The UI calls this before showing contacts so a teammate can see who has
 * already been approached rather than emailing them a second time.
 */
export async function GET(request: Request) {
  const companyName = new URL(request.url).searchParams
    .get("companyName")
    ?.trim()
    .toLowerCase();

  try {
    const contacts = await getRecordedContacts();
    const filtered = companyName
      ? contacts.filter(
          (contact) => contact.companyName.trim().toLowerCase() === companyName,
        )
      : contacts;

    return Response.json(
      { contacts: filtered, total: contacts.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GoogleSheetsConfigurationError) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (error instanceof GoogleSheetsAccessError) {
      return Response.json({ error: error.message }, { status: 502 });
    }

    return Response.json(
      { error: "Could not read recorded contacts." },
      { status: 500 },
    );
  }
}
