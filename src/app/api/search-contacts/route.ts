import "server-only";

import { verifyMonetaryWebsite } from "@/lib/exa-company-domain";
import { getAccounts } from "@/lib/google-sheets";
import { findMonetaryContacts, monetaryCompanyDomain } from "@/lib/monetary-contact-search";

export const maxDuration = 240;

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      !request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Start a contact lookup from the MISA app." }, { status: 403, headers });
  }
  try {
    const body = await request.json() as { companyName?: unknown; companyId?: unknown; website?: unknown } | null;
    const companyName = typeof body?.companyName === "string" ? body.companyName.trim() : "";
    const companyId = typeof body?.companyId === "string" ? body.companyId.trim() : null;
    if (!companyName || companyName.length > 200) {
      return Response.json({ error: "Select a monetary account first." }, { status: 400, headers });
    }
    const matches = (await getAccounts()).filter((account) =>
      account.companyName === companyName && (companyId === null || account.companyId === companyId),
    );
    if (matches.length !== 1) {
      return Response.json({ error: "The account is missing or ambiguous. Refresh the Monetary list." }, { status: 409, headers });
    }
    const account = matches[0];
    const needsChoice = body?.website != null && !monetaryCompanyDomain(account.website, companyName);
    const chosen = needsChoice ? await verifyMonetaryWebsite(companyName, account.location, body?.website) : null;
    if (needsChoice && !chosen) {
      return Response.json({ error: "Could not confirm the selected website. Clear the saved website or pick another match." }, { status: 422, headers });
    }
    return Response.json(await findMonetaryContacts(companyName, account, chosen), { headers });
  } catch {
    return Response.json({ error: "The monetary contact lookup could not complete." }, { status: 502, headers });
  }
}
