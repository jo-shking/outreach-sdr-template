import "server-only";

import {
  getRecordedContacts,
  GoogleSheetsAccessError,
  GoogleSheetsConfigurationError,
  type RecordedContact,
} from "@/lib/google-sheets";
import { listCachedResearch } from "@/lib/research-cache";

/**
 * Work already paid for: companies whose research is cached, joined with the contacts
 * recorded in the sheet. Reads only local files and the spreadsheet, so opening this view
 * costs nothing — which is the point. Re-researching a company spends another Exa search,
 * and re-revealing a contact spends another Apollo credit.
 */
export async function GET() {
  try {
    // A missing or unreadable sheet must not hide the cached research, so the two
    // sources are gathered independently.
    const [research, contactsResult] = await Promise.allSettled([
      listCachedResearch(),
      getRecordedContacts(),
    ]);

    const cached = research.status === "fulfilled" ? research.value : [];
    const contacts: RecordedContact[] =
      contactsResult.status === "fulfilled" ? contactsResult.value : [];

    const byCompany = new Map<string, RecordedContact[]>();
    for (const contact of contacts) {
      const key = contact.companyName.trim().toLowerCase();
      byCompany.set(key, [...(byCompany.get(key) ?? []), contact]);
    }

    const companies = cached.map((entry) => ({
      ...entry,
      contacts: byCompany.get(entry.companyName.trim().toLowerCase()) ?? [],
    }));

    // Contacts can exist for a company whose research cache was cleared, so surface
    // those too rather than losing them from the view.
    const cachedNames = new Set(
      cached.map((entry) => entry.companyName.trim().toLowerCase()),
    );
    const contactsOnly = [...byCompany.entries()]
      .filter(([key]) => !cachedNames.has(key))
      .map(([, rows]) => ({
        companyName: rows[0].companyName,
        cachedAt: null,
        fitScore: null,
        confidenceScore: null,
        alignmentSummary: null,
        pitchAngle: null,
        sourceCount: 0,
        personalized: false,
        contacts: rows,
      }));

    return Response.json(
      {
        companies: [...companies, ...contactsOnly],
        researchedCount: cached.length,
        contactCount: contacts.length,
        sheetError:
          contactsResult.status === "rejected"
            ? "Recorded contacts could not be read from the sheet."
            : null,
      },
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
      { error: "Could not load previously completed work." },
      { status: 500 },
    );
  }
}
