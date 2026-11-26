import { setTimeout as delay } from "node:timers/promises";
import { isSameCompanyName } from "./company-identity.ts";
import { rolePriority, validLinkedInUrl } from "./employee-normalize.ts";
import { verifiedHunterEmail, workEmailOnDomain } from "./hunter-email.ts";
import { isMonetaryTargetRole } from "./monetary-directory.ts";
import { monetaryDomainFromWebsite } from "./monetary-domain.ts";
import type { MonetaryContact, MonetaryEmailSource, ProviderOutcome } from "./monetary-waterfall.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function getOptions(header: string, key: string, body?: object, timeout = 10_000): RequestInit {
  return {
    method: body ? "POST" : "GET",
    headers: { [header]: key, "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeout),
  };
}

type ProspeoResult = { workEmail: string | null; note?: string };
type ProspeoIssue = { state: "quota" | "skipped" | "unavailable"; message: string };

const PROSPEO_SEARCH_INTERVAL_MS = 1_100;
// Schedule starts across requests served by this process. Prospeo enforces its account-wide limits.
let nextProspeoSearchAt = 0;
let prospeoSearchQueue = Promise.resolve();

function waitForProspeoSearchSlot() {
  prospeoSearchQueue = prospeoSearchQueue.then(async () => {
    const wait = nextProspeoSearchAt - performance.now();
    if (wait > 0) await delay(Math.ceil(wait));
    nextProspeoSearchAt = performance.now() + PROSPEO_SEARCH_INTERVAL_MS;
  });
  return prospeoSearchQueue;
}

function prospeoFailure(status: number, code: unknown, operation: string): ProspeoIssue {
  if (code === "INSUFFICIENT_CREDITS") {
    return { state: "quota", message: "Prospeo ran out of included Free-plan credits." };
  }
  if (status === 429 || code === "RATE_LIMITED") {
    return { state: "quota", message: "Prospeo hit an API rate limit (HTTP 429). The rejected request used no credits." };
  }
  if (status === 401 || code === "INVALID_API_KEY") {
    return { state: "unavailable", message: "Prospeo rejected the API key." };
  }
  if (code === "PLAN_REQUIRED") {
    return { state: "skipped", message: "Prospeo says this request requires a higher plan (PLAN_REQUIRED)." };
  }
  if (code === "INVALID_FILTERS") {
    return { state: "unavailable", message: "Prospeo rejected the search filters (INVALID_FILTERS)." };
  }
  if (status < 400) {
    return { state: "unavailable", message: `Prospeo returned an unexpected response during the ${operation}.` };
  }
  return { state: "unavailable", message: `Prospeo could not complete the ${operation} (HTTP ${status}).` };
}

export async function findMonetaryWorkEmail(
  { hunterKey, prospeoKey, getProspectKey, name, domain }: {
    hunterKey: string; prospeoKey?: string; getProspectKey?: string; name: string; domain: string;
  },
  request: typeof fetch = fetch,
): Promise<{ workEmail: string | null; emailSource?: MonetaryEmailSource; note?: string } | { error: string; status: number }> {
  const finder = new URL("https://api.hunter.io/v2/email-finder");
  finder.search = new URLSearchParams({ domain, full_name: name }).toString();
  const hunter = await request(finder, getOptions("X-API-KEY", hunterKey));
  if (hunter.status === 402 || hunter.status === 429) {
    return { error: "Hunter’s credit or rate limit was reached.", status: 429 };
  }
  if (!hunter.ok && hunter.status !== 404) return { error: "Hunter could not complete the email lookup.", status: 502 };
  const workEmail = hunter.ok ? verifiedHunterEmail(record(await hunter.json()).data, domain) : null;
  if (workEmail) return { workEmail, emailSource: "Hunter" };
  const fallback = await findProspeoWorkEmail({ key: prospeoKey, name, domain }, request);
  if (fallback.workEmail) return { workEmail: fallback.workEmail, emailSource: "Prospeo" };
  const last = await findGetProspectWorkEmail({ key: getProspectKey, name, domain }, request);
  if (last.workEmail) return { workEmail: last.workEmail, emailSource: "GetProspect" };
  return {
    workEmail: null,
    note: ["No verified work email found.", fallback.note, last.note].filter(Boolean).join(" "),
  };
}

async function prospeoFreeCreditsIssue(key: string, request: typeof fetch): Promise<ProspeoIssue | null> {
  const account = await request("https://api.prospeo.io/account-information", getOptions("X-KEY", key));
  const envelope = record(await account.json().catch(() => null));
  if (!account.ok || envelope.error !== false) return prospeoFailure(account.status, envelope.error_code, "Free-plan check");
  const plan = record(envelope.response);
  if (clean(plan.current_plan).toUpperCase() !== "FREE") {
    return { state: "skipped", message: "Prospeo requires a confirmed Free account." };
  }
  if (typeof plan.remaining_credits !== "number" || !Number.isSafeInteger(plan.remaining_credits) || plan.remaining_credits < 0) {
    return { state: "unavailable", message: "Prospeo did not return a readable credit balance." };
  }
  return plan.remaining_credits === 0
    ? { state: "quota", message: "Prospeo has 0 included Free-plan credits remaining." }
    : null;
}

export async function findProspeoWorkEmail(
  { key, name, domain }: { key?: string; name: string; domain: string },
  request: typeof fetch = fetch,
): Promise<ProspeoResult> {
  if (!key) return { workEmail: null, note: "Prospeo is unavailable on this deployment." };
  try {
    const issue = await prospeoFreeCreditsIssue(key, request);
    if (issue) return { workEmail: null, note: issue.message };
    const response = await request("https://api.prospeo.io/enrich-person", getOptions("X-KEY", key, {
      only_verified_email: true,
      enrich_mobile: false,
      data: { full_name: name, company_website: domain },
    }));
    const result = record(await response.json().catch(() => null));
    if (response.status === 400 && result.error_code === "NO_MATCH") return { workEmail: null };
    if (!response.ok || result.error !== false) {
      return { workEmail: null, note: prospeoFailure(response.status, result.error_code, "email lookup").message };
    }
    const person = record(result.person);
    const email = record(person.email);
    const personName = clean(person.full_name) || [clean(person.first_name), clean(person.last_name)].filter(Boolean).join(" ");
    const sameName = personName.normalize("NFKC").toLowerCase() === clean(name).normalize("NFKC").toLowerCase();
    return { workEmail: sameName && email.status === "VERIFIED" && email.revealed === true
      ? workEmailOnDomain(email.email, domain) : null };
  } catch {
    return { workEmail: null, note: "Prospeo could not complete the email lookup." };
  }
}

const BC = { include: ["British Columbia, Canada"] };
const TARGET_TITLES = {
  include: ["recruit", "talent acquisition", "early career", "communication", "community", "social impact",
    "social purpose", "corporate social responsibility", "CSR", "partnership"],
  match_mode: "CONTAINS",
};

async function getProspectFreeBalance(key: string, request: typeof fetch) {
  const account = await request("https://api.getprospect.com/v2/credits", getOptions("x-api-key", key));
  if (!account.ok) return { error: "Could not confirm GetProspect’s Free allowance." };
  const envelope = record(await account.json());
  const balance = record(record(envelope.data).email_search);
  // The API exposes the allowance but no plan name.
  if (envelope.success !== true || balance.allowance !== 50) {
    return { error: "GetProspect requires the 50-email Free allowance." };
  }
  return { balance };
}

async function findGetProspectWorkEmail(
  { key, name, domain }: { key?: string; name: string; domain: string },
  request: typeof fetch,
): Promise<ProspeoResult> {
  if (!key) return { workEmail: null, note: "GetProspect is unavailable on this deployment." };
  try {
    const account = await getProspectFreeBalance(key, request);
    if (!account.balance) return { workEmail: null, note: account.error };
    const { available, additional, permanent } = account.balance;
    if (typeof available !== "number" || !Number.isSafeInteger(available) || available < 1 ||
        available > 50 || (additional ?? 0) !== 0 || (permanent ?? 0) !== 0) {
      return { workEmail: null, note: "GetProspect has no confirmed Free-plan credits available for email." };
    }
    const response = await request("https://api.getprospect.com/v2/email/find",
      getOptions("x-api-key", key, { data: { full_name: name, domain } }, 100_000));
    if (response.status === 408) return { workEmail: null, note: "GetProspect is still checking. Try again in a few minutes." };
    if (response.status === 402 || response.status === 429) {
      return { workEmail: null, note: "GetProspect’s free credit or rate limit was reached." };
    }
    if (!response.ok) return { workEmail: null, note: "GetProspect could not complete the email lookup." };
    const result = record(await response.json());
    const data = record(result.data);
    return { workEmail: result.success === true && data.status === "valid" && data.free_email !== true
      ? workEmailOnDomain(data.email, domain) : null };
  } catch {
    return { workEmail: null, note: "GetProspect could not complete the email lookup." };
  }
}

export async function discoverGetProspectContacts(
  { key, companyName, domain, targetOnly = false }: { key?: string; companyName: string; domain: string; targetOnly?: boolean },
  request: typeof fetch = fetch,
): Promise<ProviderOutcome> {
  if (!key) return { state: "skipped", message: "GetProspect is unavailable on this deployment." };
  const account = await getProspectFreeBalance(key, request);
  if (!account.balance) return { state: "skipped", message: account.error };
  const response = await request("https://api.getprospect.com/v2/people/search", getOptions("x-api-key", key, {
    filters: {
      company: domain
        ? { domain: { include: [domain], match_mode: "PRIMARY" } }
        : { name: { include: [companyName], match_mode: "EXACT" } },
      person_location: BC,
      ...(targetOnly && { person_job_title: TARGET_TITLES }),
      ...(!domain && { company_location: BC }),
    },
    page: 1,
    enrich_email: false,
    enrich_phone: false,
  }));
  if (response.status === 429) return { state: "quota", message: "GetProspect’s free search limit was reached." };
  if (!response.ok) return { state: "unavailable", message: "GetProspect could not search for people." };
  const result = record(await response.json());
  if (result.success !== true || !Array.isArray(result.data)) {
    return { state: "unavailable", message: "GetProspect did not return a readable people list." };
  }

  const profiles = result.data.map((entry) => {
    const person = record(entry);
    const position = record(person.primary_position);
    const company = record(position.company);
    return { person, company, employerId: company.id, jobTitle: position.job_title };
  });
  return namesOnlyOutcome("GetProspect", profiles, companyName, domain);
}

export async function discoverProspeoContacts(
  { key, companyName, domain, targetOnly = false }: { key?: string; companyName: string; domain: string; targetOnly?: boolean },
  request: typeof fetch = fetch,
): Promise<ProviderOutcome> {
  if (!key) return { state: "skipped", message: "Prospeo is unavailable on this deployment." };
  const issue = await prospeoFreeCreditsIssue(key, request);
  if (issue) return issue;

  const locations = await request("https://api.prospeo.io/search-suggestions",
    getOptions("X-KEY", key, { location_search: "British Columbia" }));
  const locationResult = record(await locations.json().catch(() => null));
  if (!locations.ok || locationResult.error !== false) {
    return prospeoFailure(locations.status, locationResult.error_code, "BC location check");
  }
  const region = Array.isArray(locationResult.location_suggestions)
    ? locationResult.location_suggestions.map(record).find(({ name, type }) =>
      type === "STATE" && /^British Columbia, Canada$/i.test(clean(name)),
    ) : undefined;
  if (typeof region?.name !== "string") {
    return { state: "unavailable", message: "Prospeo could not confirm its BC location filter." };
  }

  await waitForProspeoSearchSlot();
  const response = await request("https://api.prospeo.io/search-person", getOptions("X-KEY", key, {
    filters: {
      company: domain ? { websites: { include: [domain] } } : { names: { include: [companyName] } },
      person_location_search: { include: [region.name] },
      ...(targetOnly && { person_job_title: TARGET_TITLES }),
    },
    page: 1,
  }));
  const result = record(await response.json().catch(() => null));
  if (response.status === 400 && result.error_code === "NO_RESULTS") {
    return { state: "empty", message: "Prospeo found no matching named contacts in BC." };
  }
  if (!response.ok || result.error !== false) return prospeoFailure(response.status, result.error_code, "people search");
  if (!Array.isArray(result.results)) return { state: "unavailable", message: "Prospeo did not return a readable people list." };
  const profiles = result.results.map((entry) => {
    const person = record(record(entry).person);
    const company = record(record(entry).company);
    return { person, company, employerId: company.company_id, jobTitle: person.current_job_title };
  });
  return namesOnlyOutcome("Prospeo", profiles, companyName, domain);
}

function namesOnlyOutcome(
  provider: "GetProspect" | "Prospeo",
  profiles: Array<{ person: Record<string, unknown>; company: Record<string, unknown>; employerId: unknown; jobTitle: unknown }>,
  companyName: string,
  domain: string,
): ProviderOutcome {
  const employers = new Set<string>();
  const contacts = new Map<string, MonetaryContact>();
  for (const { person, company, employerId, jobTitle } of profiles) {
    const companyDomain = monetaryDomainFromWebsite(clean(company.website) || clean(company.domain));
    const sameName = isSameCompanyName(companyName, clean(company.name));
    if (!(domain && companyDomain ? domain === companyDomain : sameName)) continue;
    const location = record(person.location);
    const country = clean(location.country_code).toUpperCase() || clean(location.country).toUpperCase();
    const province = clean(location.state_code).toUpperCase() || clean(location.state).toUpperCase();
    if (!["CA", "CANADA"].includes(country) || !["BC", "CA-BC", "BRITISH COLUMBIA"].includes(province)) continue;
    const employer = companyDomain || clean(employerId);
    if (!domain && !employer) continue;
    if (employer) employers.add(employer);
    const name = clean(person.full_name) || [clean(person.first_name), clean(person.last_name)].filter(Boolean).join(" ");
    if (name.length > 160 || !/^\S+\s+\S/.test(name) || /[*•]/.test(name)) continue;
    const title = clean(jobTitle);
    const linkedinUrl = clean(person.linkedin_url);
    const contact: MonetaryContact = {
      name, company: companyName, title, location: [clean(location.city), "British Columbia"].filter(Boolean).join(", "),
      provider, workEmail: null, linkedinUrl: validLinkedInUrl(linkedinUrl) ? linkedinUrl : null,
      sfuAlumni: false, icpMatch: isMonetaryTargetRole(title),
    };
    const identity = name.toLowerCase();
    const previous = contacts.get(identity);
    if (!previous || (!previous.icpMatch && contact.icpMatch)) contacts.set(identity, contact);
  }
  if (!domain && employers.size > 1) return {
    state: "empty", message: `${provider} found multiple BC employers with this name. Add the official website in the tracker.`,
  };
  const people = [...contacts.values()].sort((a, b) =>
    Number(b.icpMatch) - Number(a.icpMatch) || rolePriority(b.title) - rolePriority(a.title),
  ).slice(0, 10);
  return people.length
    ? { state: "profiles", contacts: people, message: "Names only. You can check a person’s work email individually." }
    : { state: "empty", message: `${provider} found no matching named contacts in BC.` };
}
