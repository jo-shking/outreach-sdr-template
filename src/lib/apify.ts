import "server-only";

import {
  isGreaterVancouver,
  normalizeEmployee,
  type EmployeeCandidate,
  type RejectionReason,
} from "@/lib/employee-normalize";

export type { EmployeeCandidate };

export class ApifyConfigurationError extends Error {}

export class ApifyConnectionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

type ApifyRecord = Record<string, unknown>;

// thirdwatch runs on Apify's free plan and returns real publisher-side profile URLs plus
// education data. harvestapi gates free-plan users at 10 runs, finishing SUCCEEDED with an
// empty dataset, so it is only usable on a paid Apify plan.
const DEFAULT_EMPLOYEE_ACTOR = "thirdwatch~linkedin-company-employees-scraper";
// The actor bills per profile it returns, so this is the real cost dial. A measured run
// against Apply Digital kept only 2 of 6 profiles once the company-identity and
// usable-title checks ran, so this needs real headroom above MAX_CONTACTS_RETURNED.
const MAX_PROFILES_FETCHED = 10;
// Every verified contact is shown, with or without an SFU connection: yield is low
// enough that hiding any is worse than a longer list.
const MAX_CONTACTS_RETURNED = MAX_PROFILES_FETCHED;
const TARGET_LOCATION = "Greater Vancouver Metropolitan Area";
const HARVESTAPI_SEARCH_QUERY =
  '"campus recruiter" OR "university recruiter" OR "early careers" OR "talent acquisition" OR "communications specialist" OR "social purpose" OR "social impact" OR partnerships OR marketing OR community OR recruiting';

function record(value: unknown): ApifyRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ApifyRecord)
    : null;
}

function stringValue(value: unknown, maxLength = 500) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

function validLinkedInCompanyUrl(value: string | null) {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) &&
      url.pathname.startsWith("/company/")
    );
  } catch {
    return false;
  }
}

/**
 * Every actor defines its own input schema. Sending one actor's field names to another
 * produces a successful run with an empty dataset rather than an error, so an unknown
 * actor is rejected loudly instead of being handed a guessed input shape.
 */
const ACTOR_INPUTS: Record<
  string,
  (args: { companyTarget: string }) => ApifyRecord
> = {
  "thirdwatch~linkedin-company-employees-scraper": ({ companyTarget }) => ({
    queries: [companyTarget],
    // "full" is what returns work history and education; "basic" omits education and
    // would silently disable SFU-alumni detection.
    mode: "full",
    location: TARGET_LOCATION,
    maxResults: MAX_PROFILES_FETCHED,
    // No jobTitle filter on purpose: it accepts a single title string, while we care about
    // roughly eight role families. Over-filtering returns nobody, so the candidate pool is
    // ranked by rolePriority() on our side instead.
  }),
  "harvestapi~linkedin-company-employees": ({ companyTarget }) => ({
    companies: [companyTarget],
    locations: [TARGET_LOCATION],
    profileScraperMode: "Full ($8 per 1k)",
    searchQuery: HARVESTAPI_SEARCH_QUERY,
    maxItems: MAX_PROFILES_FETCHED,
    companyBatchMode: "all_at_once",
  }),
};

function requiredApifyToken() {
  const token = process.env.APIFY_TOKEN?.trim();

  if (!token) {
    throw new ApifyConfigurationError(
      "APIFY_TOKEN is not configured on the server.",
    );
  }

  return token;
}

export async function testApifyConnection() {
  const token = requiredApifyToken();
  let response: Response;

  try {
    response = await fetch("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApifyConnectionError("The server could not reach Apify.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new ApifyConnectionError(
      "Apify rejected the configured token.",
      response.status,
    );
  }

  if (!response.ok) {
    throw new ApifyConnectionError(
      "Apify rejected the connection test.",
      response.status,
    );
  }

  return { connected: true as const };
}

/**
 * An actor can exhaust its own free-tier allowance and still finish with status
 * SUCCEEDED, exit code 0, and an empty dataset — the reason appears only in
 * `statusMessage` on the detailed run object, which the run-sync endpoint does not
 * return. Without this lookup a hard quota wall is indistinguishable from a company
 * that genuinely has no matching employees.
 */
async function latestRunStatusMessage(token: string, actorId: string) {
  try {
    const list = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?limit=1&desc=1`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!list.ok) return null;

    const listData = record(record(await list.json())?.data);
    const runs = listData && Array.isArray(listData.items) ? listData.items : [];
    const runId = stringValue(record(runs[0])?.id, 100);

    if (!runId) return null;

    const detail = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!detail.ok) return null;

    return stringValue(record(record(await detail.json())?.data)?.statusMessage, 300);
  } catch {
    // A diagnostic lookup must never turn into the caller's failure.
    return null;
  }
}

function isQuotaMessage(message: string) {
  return /limit|exceed|upgrade|quota|paid plan|subscription|trial/i.test(message);
}

// Written as plain clauses that complete "N profiles ...", because these notes are read
// by whoever is deciding which contact to approach, not by a developer.
const REJECTION_LABELS: Record<RejectionReason, string> = {
  not_an_object: "came back malformed",
  no_profile_url: "had no usable LinkedIn profile link",
  no_current_company:
    "list no employer at all on LinkedIn, so their employment here could not be confirmed",
  company_mismatch:
    "list a different current employer on LinkedIn, so they have most likely moved on",
  no_name: "had no name",
  no_title: "had no job title",
  title_repeats_company: "had the company name where a job title should be",
};

function describeRejections(rejections: readonly RejectionReason[]) {
  const counts = new Map<RejectionReason, number>();
  for (const reason of rejections) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${REJECTION_LABELS[reason]}`)
    .join(". ");
}

export async function findCompanyEmployees(
  companyName: string,
  linkedinCompanyUrl: string | null,
  budget?: { maxTotalChargeUsd: number; timeoutSeconds: number },
  monetaryToken?: string,
) {
  const token = monetaryToken ?? requiredApifyToken();
  const actorId = (
    process.env.APIFY_EMPLOYEE_ACTOR_ID?.trim() || DEFAULT_EMPLOYEE_ACTOR
  ).replace("/", "~");
  const buildInput = ACTOR_INPUTS[actorId];

  if (!buildInput) {
    throw new ApifyConfigurationError(
      `APIFY_EMPLOYEE_ACTOR_ID is set to "${actorId}", which has no input mapping. Supported actors: ${Object.keys(ACTOR_INPUTS).join(", ")}. Add a mapping before using a different actor, because sending the wrong input shape returns an empty run rather than an error.`,
    );
  }

  const query = new URLSearchParams({ timeout: String(budget?.timeoutSeconds ?? 240) });
  if (budget) {
    query.set("maxTotalChargeUsd", String(budget.maxTotalChargeUsd));
    query.set("limit", String(MAX_PROFILES_FETCHED));
    query.set("restartOnError", "false");
  }
  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?${query}`;
  const input = buildInput({
    companyTarget: validLinkedInCompanyUrl(linkedinCompanyUrl)
      ? linkedinCompanyUrl!
      : companyName,
  });
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: AbortSignal.timeout(budget ? (budget.timeoutSeconds + 5) * 1_000 : 270_000),
    });
  } catch {
    throw new ApifyConnectionError(
      "The server could not complete the Apify employee search.",
    );
  }

  if (!response.ok) {
    throw new ApifyConnectionError(
      "Apify rejected the employee search.",
      response.status,
    );
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new ApifyConnectionError(
      "Apify returned an unreadable employee-search response.",
    );
  }

  if (!Array.isArray(data)) {
    throw new ApifyConnectionError(
      "Apify returned an unexpected employee-search response.",
    );
  }

  // An empty dataset is never a research finding, so establish why before reporting it.
  if (data.length === 0) {
    const statusMessage = budget ? null : await latestRunStatusMessage(token, actorId);

    if (statusMessage && isQuotaMessage(statusMessage)) {
      throw new ApifyConnectionError(
        `The Apify actor "${actorId}" returned no profiles because of an upstream limit: "${statusMessage}". Contact search will keep returning nothing until that actor's plan is upgraded or a different actor is configured via APIFY_EMPLOYEE_ACTOR_ID.`,
      );
    }

    return {
      companyName,
      employees: [],
      limitations: [
        statusMessage
          ? `The Apify actor returned no profiles at all. Its most recent run reported: "${statusMessage}".`
          : "The Apify actor returned no profiles at all, so no candidate was evaluated against the company-identity check.",
      ],
    };
  }

  const accessedAt = new Date().toISOString();
  const seenProfiles = new Set<string>();
  const rejections: RejectionReason[] = [];
  const usable = data
    .map((item) => normalizeEmployee(item, companyName, accessedAt, rejections))
    .filter((item): item is EmployeeCandidate => Boolean(item))
    .filter((item) => {
      if (seenProfiles.has(item.linkedinUrl)) return false;
      seenProfiles.add(item.linkedinUrl);
      return true;
    })
    .sort((a, b) => {
      const sfuRank = (candidate: EmployeeCandidate) =>
        candidate.sfuConnection === "alumni"
          ? 2
          : candidate.sfuConnection === "education"
            ? 1
            : 0;
      // Local contacts rank above remote ones, but remote profiles are still offered
      // rather than discarded: they were paid for and remain valid sponsorship contacts.
      const localRank = (candidate: EmployeeCandidate) =>
        isGreaterVancouver(candidate.location) ? 1 : 0;

      return (
        sfuRank(b) - sfuRank(a) ||
        localRank(b) - localRank(a) ||
        b.rolePriority - a.rolePriority
      );
    });
  const employees = usable.slice(0, MAX_CONTACTS_RETURNED);
  const dropped = data.length - usable.length;
  const nonLocal = employees.filter(
    (employee) => !isGreaterVancouver(employee.location),
  ).length;

  return {
    companyName,
    employees,
    // Say what happened to every profile that was paid for, so a low yield reads as a
    // filtering outcome rather than as an empty search.
    limitations: [
      // No separate "nothing survived" line: when everything is dropped, `dropped`
      // equals the profile count and the breakdown below already says so, with reasons.
      ...(dropped > 0
        ? [
            `The search returned ${data.length} profiles and ${dropped} could not be verified as current ${companyName} staff, so they are not shown. ${describeRejections(rejections)}.`,
          ]
        : []),
      ...(nonLocal > 0
        ? [
            nonLocal === employees.length
              ? `${employees.length === 1 ? "The only contact shown is" : "Every contact shown is"} outside Greater Vancouver. Nobody local passed verification for this account.`
              : `${nonLocal} of the ${employees.length} contacts shown are outside Greater Vancouver; local contacts are listed first.`,
          ]
        : []),
    ],
  };
}
