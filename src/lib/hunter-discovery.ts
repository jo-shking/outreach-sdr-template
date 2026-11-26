import { validLinkedInUrl } from "./employee-normalize.ts";
import { websiteNotFoundMessage, type ExaDomainResult } from "./exa-company-domain.ts";
import { hunterFreeAllowance, verifiedHunterEmail } from "./hunter-email.ts";
import { isMonetaryTargetRole } from "./monetary-directory.ts";
import { monetaryDomainFromWebsite } from "./monetary-domain.ts";
import { compareMonetaryFit, type HunterSearchCounts, type MonetaryContact, type ProviderOutcome } from "./monetary-waterfall.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizedCompanyName(value: unknown) {
  return clean(value).normalize("NFKC").toLowerCase();
}

function singleMatchedDomain(rows: unknown, companyName: string) {
  const domains = new Set<string>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const { company_name, domain } = record(row);
      const host = monetaryDomainFromWebsite(clean(domain));
      if (host && normalizedCompanyName(company_name) === normalizedCompanyName(companyName)) {
        domains.add(host);
      }
    }
  }
  return domains.size === 1 ? [...domains][0] : "";
}

function failure(status: number): ProviderOutcome {
  if (status === 402 || status === 429) return { state: "quota", message: "Hunter's credit or rate limit was reached." };
  if (status === 401 || status === 403) return { state: "unavailable", message: "Hunter did not authorize this request." };
  return { state: "unavailable", message: "Hunter could not complete the company search." };
}

export async function discoverHunterContacts(
  { companyName, domain, key, sharedDomain = false, findWebsite }: {
    companyName: string; domain: string; key: string | undefined; sharedDomain?: boolean;
    findWebsite?: () => Promise<ExaDomainResult>;
  },
  request: typeof fetch = fetch,
): Promise<ProviderOutcome> {
  if (!key) return { state: "skipped", message: "Hunter is unavailable on this deployment." };
  const headers = { "X-API-KEY": key };
  function get(path: string, params?: Record<string, string>) {
    const url = new URL(path, "https://api.hunter.io/v2/");
    if (params) url.search = new URLSearchParams(params).toString();
    return request(url, {
      headers, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  }

  const account = await get("account");
  if (!account.ok) return failure(account.status);
  if (!hunterFreeAllowance(record(await account.json()).data)) {
    return { state: "quota", message: "Hunter requires a Free account with at least one included credit remaining." };
  }
  let websiteNote = "";
  let evidence: { website?: NonNullable<ProviderOutcome["website"]> } = {};
  if (!domain) {
    const resolved = await resolveHunterDomain(companyName, key, request);
    if (resolved.status) return failure(resolved.status);
    domain = resolved.domain;
    if (!domain) {
      const website = await findWebsite?.();
      if (!website || "reason" in website) {
        return { state: "empty", message: websiteNotFoundMessage(website),
          ...(website?.reason === "ambiguous" && { websiteCandidates: website.candidates }) };
      }
      domain = website.domain;
      evidence = { website };
      websiteNote = ` Exa matched ${domain} to ${companyName} in ${website.location}.`;
    }
  }
  if (!evidence.website) evidence = { website: { domain } };

  const response = await get("domain-search", {
    domain, limit: "10", type: "personal", provenance: "found",
  });
  if (!response.ok) {
    const result = failure(response.status);
    return { ...result, ...evidence, message: result.message + websiteNote };
  }
  const data = record(record(await response.json()).data);
  if (!Array.isArray(data.emails)) return { state: "unavailable", ...evidence, message: "Hunter did not return a readable contact list." + websiteNote };
  const hunterCounts: HunterSearchCounts = {
    returned: data.emails.length, noNamedPerson: 0, outsideIcp: 0, emailMissing: 0,
    wrongOrInvalidAddress: 0, catchAll: 0, unverified: 0, outsideCompanyScope: 0,
  };
  if (data.emails.length === 0 || clean(data.domain).toLowerCase() !== domain ||
      data.webmail === true || data.disposable === true) {
    hunterCounts.outsideCompanyScope = data.emails.length;
    return { state: "empty", ...evidence, message: "Hunter returned no people on the company domain." + websiteNote, hunterCounts };
  }
  const contacts = data.emails.flatMap((entry): MonetaryContact[] => {
    const person = record(entry);
    const first = clean(person.first_name);
    const last = clean(person.last_name);
    const title = clean(person.position);
    if (!first || !last || /[*•]/.test(first + last) || person.type !== "personal") {
      hunterCounts.noNamedPerson++;
      return [];
    }
    const department = clean(person.department).toLowerCase();
    const icpMatch = sharedDomain || isMonetaryTargetRole(title);
    if (!icpMatch) hunterCounts.outsideIcp++;
    const status = record(person.verification).status;
    const workEmail = verifiedHunterEmail({ email: person.value, verification: person.verification }, domain);
    if (!workEmail) {
      if (!clean(person.value)) hunterCounts.emailMissing++;
      else if (!verifiedHunterEmail({ email: person.value, verification: { status: "valid" } }, domain)) hunterCounts.wrongOrInvalidAddress++;
      else if (status === "accept_all") hunterCounts.catchAll++;
      else hunterCounts.unverified++;
    }
    return [{
      name: `${first} ${last}`, company: companyName, title, location: "Location not verified",
      provider: "Hunter", icpMatch, ...(department && { department }),
      linkedinUrl: validLinkedInUrl(person.linkedin) ? person.linkedin : null,
      workEmail, sfuAlumni: false, ...(workEmail ? { emailVerification: "verified" } : {}),
    }];
  }).sort(compareMonetaryFit);
  return {
    state: contacts.some(({ workEmail, icpMatch }) => workEmail && icpMatch) ? "found" : contacts.length ? "profiles" : "empty",
    contacts, hunterCounts,
    ...evidence,
    message: (contacts.length ? "Hunter does not confirm where a person is based." : "Hunter returned no matching people.") + websiteNote,
  };
}

export async function resolveHunterDomain(companyName: string, key: string, request: typeof fetch = fetch) {
  if (clean(companyName).length < 3) return { domain: "" };
  const url = new URL("https://api.hunter.io/v2/domain-finder");
  url.search = new URLSearchParams({ company: companyName, limit: "10", perfect_match: "true" }).toString();
  const response = await request(url, {
    headers: { "X-API-KEY": key }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  return response.ok ? { domain: singleMatchedDomain(record(await response.json()).data, companyName) }
    : { domain: "", status: response.status };
}
