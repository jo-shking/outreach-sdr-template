import "server-only";

import { isSameCompanyName } from "@/lib/company-identity";

export class ApolloConfigurationError extends Error {}

export class ApolloConnectionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

type ApolloRecord = Record<string, unknown>;

function record(value: unknown): ApolloRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function stringValue(value: unknown, maxLength = 500) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

function requiredApolloApiKey() {
  const key = process.env.APOLLO_API_KEY?.trim();

  if (!key) {
    throw new ApolloConfigurationError(
      "APOLLO_API_KEY is not configured on the server.",
    );
  }

  return key;
}

function canonicalLinkedInProfile(value: string | null) {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      return null;
    }
    if (
      url.hostname !== "linkedin.com" &&
      !url.hostname.endsWith(".linkedin.com")
    ) {
      return null;
    }
    if (!url.pathname.startsWith("/in/")) return null;

    return url.pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function isProfessionalEmail(value: string | null): value is string {
  return value
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320
    : false;
}

function apolloError(status: number) {
  if (status === 401) {
    return new ApolloConnectionError(
      "Apollo rejected the configured API key.",
      status,
    );
  }

  if (status === 403) {
    return new ApolloConnectionError(
      "This Apollo plan or API key does not have access to People Enrichment.",
      status,
    );
  }

  if (status === 429) {
    return new ApolloConnectionError(
      "Apollo's rate or credit limit was reached.",
      status,
    );
  }

  return new ApolloConnectionError(
    "Apollo rejected the enrichment request.",
    status,
  );
}

export async function testApolloConnection() {
  const key = requiredApolloApiKey();
  let response: Response;

  try {
    response = await fetch("https://api.apollo.io/api/v1/auth/health", {
      headers: {
        accept: "application/json",
        "x-api-key": key,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApolloConnectionError("The server could not reach Apollo.");
  }

  if (!response.ok) throw apolloError(response.status);

  return { connected: true as const };
}

export async function enrichProfessionalEmail({
  name,
  companyName,
  linkedinUrl,
}: {
  name: string;
  companyName: string;
  linkedinUrl: string;
}) {
  const key = requiredApolloApiKey();
  const expectedLinkedInProfile = canonicalLinkedInProfile(linkedinUrl);

  if (!expectedLinkedInProfile) {
    throw new ApolloConnectionError(
      "A valid LinkedIn profile URL is required for Apollo enrichment.",
    );
  }

  const endpoint = new URL("https://api.apollo.io/api/v1/people/match");
  endpoint.searchParams.set("name", name);
  endpoint.searchParams.set("organization_name", companyName);
  endpoint.searchParams.set("linkedin_url", linkedinUrl);
  endpoint.searchParams.set("reveal_personal_emails", "false");
  endpoint.searchParams.set("reveal_phone_number", "false");

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApolloConnectionError(
      "The server could not complete the Apollo enrichment request.",
    );
  }

  if (!response.ok) throw apolloError(response.status);

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new ApolloConnectionError(
      "Apollo returned an unreadable enrichment response.",
    );
  }

  const person = record(record(data)?.person);
  if (!person) {
    return {
      email: null,
      limitations: ["Apollo did not return a matching person."],
    };
  }

  const returnedLinkedInProfile = canonicalLinkedInProfile(
    stringValue(person.linkedin_url),
  );
  const organization = record(person.organization);
  const returnedCompany = stringValue(organization?.name, 300);

  if (
    returnedLinkedInProfile !== expectedLinkedInProfile ||
    !returnedCompany ||
    !isSameCompanyName(companyName, returnedCompany)
  ) {
    return {
      email: null,
      limitations: [
        "Apollo's match did not verify against both the LinkedIn profile and current employer.",
      ],
    };
  }

  const email = stringValue(person.email, 320);
  const emailStatus = stringValue(person.email_status, 100)?.toLowerCase();

  if (!isProfessionalEmail(email) || emailStatus !== "verified") {
    return {
      email: null,
      limitations: ["Apollo did not return a verified professional email."],
    };
  }

  return {
    email: {
      value: email,
      status: "verified" as const,
      source: "Apollo" as const,
      accessedAt: new Date().toISOString(),
    },
    limitations: [],
  };
}

/**
 * Apollo's people search. Unlike enrichment this consumes no credits, so it is safe to
 * run on every account — but it is gated behind a paid plan, and on a trial it returns
 * 403 with an explanatory message that the caller surfaces verbatim.
 *
 * Apollo carries no education history, so contacts found here always have
 * sfuConnection null; an SFU tie has to come from cross-referencing Apify.
 *
 * NOTE: written against Apollo's documented response shape and not yet exercised against
 * a live payload, because the endpoint is inaccessible on the current plan.
 */
export async function findCompanyPeople({
  companyDomain,
  personLocations,
  perPage,
}: {
  companyDomain: string;
  personLocations: readonly string[];
  perPage: number;
}, monetaryApiKey?: string) {
  const key = monetaryApiKey ?? requiredApolloApiKey();
  let response: Response;

  try {
    response = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        q_organization_domains_list: [companyDomain],
        person_locations: [...personLocations],
        page: 1,
        per_page: perPage,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApolloConnectionError(
      "The server could not complete the Apollo people search.",
    );
  }

  if (!response.ok) {
    // Apollo states the plan restriction in the body; passing it through means the
    // reason reaches whoever has to act on it rather than being flattened to "403".
    const detail = stringValue(
      record(await response.json().catch(() => null))?.error,
      300,
    );

    throw new ApolloConnectionError(
      detail ?? `Apollo rejected the people search (HTTP ${response.status}).`,
      response.status,
    );
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new ApolloConnectionError(
      "Apollo returned an unreadable people-search response.",
    );
  }

  const body = record(data);
  const people = Array.isArray(body?.people) ? body.people : null;

  if (!people) {
    // A shape mismatch must be loud: silently returning nothing is what made the Apify
    // quota wall look like a company with no employees.
    throw new ApolloConnectionError(
      "Apollo's people-search response had no \"people\" array. The documented response shape may have changed.",
    );
  }

  return { people, total: record(body?.pagination)?.total_entries ?? null };
}

export type ApolloCapability = {
  name: string;
  endpoint: string;
  available: boolean;
  detail: string | null;
};

/**
 * Reports which Apollo APIs this plan can actually reach. Every probe is deliberately
 * unmatchable — a nonsense domain, a fake person — because Apollo charges only when it
 * finds credit-consuming data, so a guaranteed miss costs nothing. A 403 means the plan
 * gates the endpoint; anything else means it is reachable.
 */
export async function checkApolloCapabilities(): Promise<{
  connected: true;
  creditsRemaining: number | null;
  capabilities: ApolloCapability[];
}> {
  const key = requiredApolloApiKey();
  const headers = {
    accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": key,
  };

  async function probe(
    name: string,
    endpoint: string,
    init: RequestInit,
  ): Promise<ApolloCapability> {
    try {
      const response = await fetch(`https://api.apollo.io${endpoint}`, {
        ...init,
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const detail = stringValue(
        record(await response.json().catch(() => null))?.error,
        300,
      );

      return {
        name,
        endpoint,
        available: response.status !== 403,
        detail: detail ?? (response.ok ? null : `HTTP ${response.status}`),
      };
    } catch {
      return { name, endpoint, available: false, detail: "Could not reach Apollo." };
    }
  }

  const capabilities = await Promise.all([
    probe("Lead search (find contacts)", "/api/v1/mixed_people/api_search", {
      method: "POST",
      body: JSON.stringify({
        q_organization_domains_list: ["example-domain-that-does-not-exist-98765.test"],
        page: 1,
        per_page: 1,
      }),
    }),
    probe("Email enrichment", "/api/v1/people/match", {
      method: "POST",
      body: JSON.stringify({
        name: "Zzzz Nonexistent Probe",
        organization_name: "example-domain-that-does-not-exist-98765.test",
        reveal_personal_emails: false,
        reveal_phone_number: false,
      }),
    }),
    probe("Company lookup (name to domain)", "/api/v1/organizations/search", {
      method: "POST",
      body: JSON.stringify({
        q_organization_name: "Zzzz Nonexistent Probe Company",
        page: 1,
        per_page: 1,
      }),
    }),
  ]);

  let creditsRemaining: number | null = null;

  try {
    const profile = await fetch(
      "https://api.apollo.io/api/v1/users/api_profile?include_credit_usage=true",
      { headers, cache: "no-store", signal: AbortSignal.timeout(20_000) },
    );

    if (profile.ok) {
      const find = (value: unknown): number | null => {
        const item = record(value);
        if (!item) return null;
        if (typeof item.num_credits_remaining === "number") {
          return item.num_credits_remaining;
        }
        for (const nested of Object.values(item)) {
          const hit = find(nested);
          if (hit !== null) return hit;
        }
        return null;
      };
      creditsRemaining = find(await profile.json());
    }
  } catch {
    // Credit balance is informational; its absence must not fail the check.
  }

  return { connected: true, creditsRemaining, capabilities };
}

/**
 * Resolves a company name to its primary domain, for accounts whose Website column is
 * blank and whose research has not run yet. Costs 1 credit only when Apollo finds a
 * match; a miss is free. Preferred order is still the sheet's website, then the domain
 * inferred from Exa research, then this — because those two cost nothing.
 */
export async function resolveCompanyDomain(companyName: string) {
  const key = requiredApolloApiKey();
  let response: Response;

  try {
    response = await fetch("https://api.apollo.io/api/v1/organizations/search", {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        q_organization_name: companyName,
        page: 1,
        per_page: 1,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  try {
    const body = record(await response.json());
    const organizations = Array.isArray(body?.organizations)
      ? body.organizations
      : [];
    const first = record(organizations[0]);
    if (!first) return null;

    const domain = stringValue(first.primary_domain, 300);
    const name = stringValue(first.name, 300);

    // Company names are ambiguous — searching "ITS Consulting" returns three unrelated
    // firms — so only trust the match when the returned name agrees with the account.
    if (!domain || !name || !isSameCompanyName(companyName, name)) return null;

    return { domain, matchedName: name };
  } catch {
    return null;
  }
}

/**
 * Spends one credit to unmask a person found by search. Apollo withholds the surname,
 * email and LinkedIn URL until this call, so this is the only way a preview becomes a
 * contact worth writing to. Costs nothing when Apollo finds no credit-consuming data.
 *
 * Verification here is by domain, not by company name: the search that produced this id
 * was already scoped to the account's domain, and Apollo reports current brand names
 * ("APPLY") that will not match a sheet's historical name ("Apply Digital").
 */
export async function revealApolloContact({
  apolloId,
  expectedDomain,
}: {
  apolloId: string;
  expectedDomain: string | null;
}) {
  const key = requiredApolloApiKey();
  let response: Response;

  try {
    response = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        id: apolloId,
        reveal_personal_emails: false,
        reveal_phone_number: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApolloConnectionError(
      "The server could not complete the Apollo reveal request.",
    );
  }

  if (!response.ok) throw apolloError(response.status);

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new ApolloConnectionError("Apollo returned an unreadable reveal response.");
  }

  const person = record(record(data)?.person);

  if (!person) {
    return {
      contact: null,
      limitations: ["Apollo could not reveal this person."],
    };
  }

  const organization = record(person.organization);
  const returnedDomain = stringValue(organization?.primary_domain, 300)
    ?.replace(/^www\./i, "")
    .toLowerCase();

  if (
    expectedDomain &&
    returnedDomain &&
    returnedDomain !== expectedDomain.replace(/^www\./i, "").toLowerCase()
  ) {
    return {
      contact: null,
      limitations: [
        `Apollo revealed someone at ${returnedDomain}, not ${expectedDomain}, so the result was discarded.`,
      ],
    };
  }

  const name = stringValue(person.name, 400);
  const linkedinUrl = stringValue(person.linkedin_url, 500);
  const email = stringValue(person.email, 320);
  const emailStatus = stringValue(person.email_status, 100)?.toLowerCase();
  const verifiedEmail =
    isProfessionalEmail(email) && emailStatus === "verified" ? email : null;
  const limitations: string[] = [];

  if (!verifiedEmail) {
    limitations.push(
      email
        ? `Apollo returned an email with status "${emailStatus ?? "unknown"}" rather than verified, so it was not accepted.`
        : "Apollo revealed this person but returned no work email.",
    );
  }

  return {
    contact: {
      name,
      title: stringValue(person.title, 300),
      // Apollo reports the current brand, which may differ from the sheet's name.
      organizationName: stringValue(organization?.name, 300),
      organizationDomain: returnedDomain ?? null,
      linkedinUrl,
      location:
        [
          stringValue(person.city, 100),
          stringValue(person.state, 100),
          stringValue(person.country, 100),
        ]
          .filter(Boolean)
          .join(", ") || null,
      email: verifiedEmail
        ? {
            value: verifiedEmail,
            status: "verified" as const,
            source: "Apollo" as const,
            accessedAt: new Date().toISOString(),
          }
        : null,
    },
    limitations,
  };
}
