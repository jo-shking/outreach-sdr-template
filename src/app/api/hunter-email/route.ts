import "server-only";

import { configuredExaCompanyDomain, verifyMonetaryWebsite, websiteNotFoundMessage } from "@/lib/exa-company-domain";
import { getAccounts } from "@/lib/google-sheets";
import { resolveHunterDomain } from "@/lib/hunter-discovery";
import { hunterFreeAllowance } from "@/lib/hunter-email";
import { monetaryCompanyDomain } from "@/lib/monetary-contact-search";
import { findMonetaryWorkEmail } from "@/lib/monetary-provider-fallbacks";

const headers = { "Cache-Control": "no-store" };

export const maxDuration = 240;

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers });
}

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      !request.headers.get("content-type")?.startsWith("application/json")) {
    return error("Start an email lookup from the MISA app.", 403);
  }

  const body = await request.json().catch(() => null);
  const companyName = typeof body?.companyName === "string" ? body.companyName.trim() : "";
  const companyId = typeof body?.companyId === "string" ? body.companyId.trim() : null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!companyName || companyName.length > 200 || name.length > 160 ||
      !/^\S+\s+\S/.test(name) || /[*•]/.test(name)) {
    return error("Select a company and a contact with a full name.", 400);
  }

  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key) return error("Hunter is unavailable on this deployment.", 503);

  try {
    const matches = (await getAccounts()).filter((account) =>
      account.companyName === companyName && (companyId === null || account.companyId === companyId),
    );
    if (matches.length !== 1) return error("Refresh the Monetary list and select the company again.", 409);
    let domain = monetaryCompanyDomain(matches[0].website, companyName);
    if (!domain && body?.website != null) {
      const chosen = await verifyMonetaryWebsite(companyName, matches[0].location, body.website);
      if (!chosen) return error("Could not confirm the selected website. Clear the saved website or pick another match.", 422);
      domain = chosen.domain;
    }

    const options = {
      headers: { "X-API-KEY": key },
      cache: "no-store",
      redirect: "error",
    } as const;
    const account = await fetch("https://api.hunter.io/v2/account", { ...options, signal: AbortSignal.timeout(20_000) });
    if (!account.ok) return error("Hunter could not confirm the account's Free plan.", 502);
    if (!hunterFreeAllowance((await account.json()).data)) {
      return error("Hunter requires a Free account with at least one free credit remaining.", 403);
    }
    if (!domain) {
      const resolved = await resolveHunterDomain(companyName, key);
      if (resolved.status === 402 || resolved.status === 429) return error("Hunter's credit or rate limit was reached.", 429);
      if (resolved.status) return error("Hunter could not check the company domain.", 502);
      domain = resolved.domain;
      if (!domain) {
        const website = await configuredExaCompanyDomain(companyName, matches[0]);
        if ("reason" in website) return error(websiteNotFoundMessage(website), 422);
        domain = website.domain;
      }
    }

    const result = await findMonetaryWorkEmail({
      hunterKey: key, prospeoKey: process.env.PROSPEO_API_KEY?.trim(),
      getProspectKey: process.env.GETPROSPECT_API_KEY?.trim(), name, domain,
    });
    if ("error" in result) return error(result.error, result.status);
    return Response.json(result, { headers });
  } catch {
    return error("The Hunter lookup could not complete.", 502);
  }
}
