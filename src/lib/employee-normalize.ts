// Pure normalization for employee-search results, kept free of "server-only" so the
// field mapping can be unit tested. Actors disagree on field names for the same facts,
// so every lookup below accepts the shapes we have actually observed:
//   thirdwatch~linkedin-company-employees-scraper  (current default)
//   harvestapi~linkedin-company-employees          (previous default)
// A mapping bug here looks exactly like "no employees found", so it is worth pinning.
import { isSameCompanyName } from "./company-identity.ts";

export type EmployeeCandidate = {
  name: string;
  title: string;
  currentCompany: string;
  currentEmploymentEvidence: string;
  linkedinUrl: string;
  location: string | null;
  sourceUrl: string;
  accessedAt: string;
  rolePriority: number;
  sfuConnection: "alumni" | "education" | null;
  sfuEvidence: string | null;
};

type Record_ = Record<string, unknown>;

function record(value: unknown): Record_ | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record_)
    : null;
}

function stringValue(value: unknown, maxLength = 500) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

function recordList(value: unknown): Record_[] {
  return (Array.isArray(value) ? value : [])
    .map(record)
    .filter((entry): entry is Record_ => Boolean(entry));
}

export function validLinkedInUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) &&
      url.pathname.startsWith("/in/")
    );
  } catch {
    return false;
  }
}

/**
 * Scores at or above this matched one of the named role families MISA targets. Below it
 * sit generic seniority (60: "Director", "VP" with no function) and unrecognised roles
 * (20), which are people worth keeping on the list but not worth leading with.
 */
export const TARGET_ROLE_MIN_PRIORITY = 70;

export function isTargetRole(priority: number) {
  return priority >= TARGET_ROLE_MIN_PRIORITY;
}

export function rolePriority(title: string) {
  const value = title.toLowerCase();

  if (
    /campus recruit|university recruit|early careers? recruit|student recruit/.test(
      value,
    )
  ) {
    return 120;
  }
  if (
    /talent acquisition/.test(value) &&
    /lead|head|director|manager|chief|vice president|\bvp\b/.test(value)
  ) {
    return 115;
  }
  if (/communications? specialist/.test(value)) return 110;
  if (
    /social purpose|social impact|community impact|corporate social responsibility|\bcsr\b/.test(
      value,
    )
  ) {
    return 105;
  }
  if (/talent acquisition|recruit/.test(value)) return 95;
  if (/partnership|alliances/.test(value)) return 90;
  if (/communications|community|marketing|brand/.test(value)) return 85;
  // Any chief officer, not just the CEO: a COO or CMO is a real sponsorship
  // decision-maker and previously scored the same as an unrecognised role.
  if (
    /founder|owner|chief executive|chief \w+ officer|\bc[eofmtir]o\b/.test(value)
  ) {
    return 80;
  }
  if (/people operations|human resources|\bhr\b/.test(value)) return 75;
  if (/business development|growth/.test(value)) return 70;
  if (/president|vice president|\bvp\b|director|head of/.test(value)) return 60;
  return 20;
}

/** thirdwatch exposes `url`; harvestapi exposes `linkedinUrl`. */
function profileUrl(item: Record_) {
  for (const candidate of [item.url, item.linkedinUrl, item.profileUrl]) {
    if (validLinkedInUrl(candidate)) return candidate;
  }
  return null;
}

/**
 * thirdwatch gives the current employer as a top-level string, which is more reliable
 * than harvestapi's approach of scanning the experience list for an entry whose end date
 * reads "present".
 */
function currentEmployer(item: Record_) {
  const direct = stringValue(item.currentCompany);
  if (direct) return direct;

  const present = recordList(item.experience).find((entry) => {
    const endDate = record(entry.endDate);
    return stringValue(endDate?.text, 100)?.toLowerCase() === "present";
  });
  const fromExperience = stringValue(present?.companyName);
  if (fromExperience) return fromExperience;

  const positions = recordList(item.currentPositions);
  const current = positions.find((entry) => entry.current === true) ?? positions[0];
  const fromPositions = stringValue(current?.companyName);
  if (fromPositions) return fromPositions;

  // thirdwatch omits endDate entirely, so the "present" scan above never fires for it and
  // profiles with an empty currentCompany were being discarded. LinkedIn lists experience
  // most-recent-first, so the first named employer is the current one. Someone who has
  // since moved on lists their new employer first and is still rejected by the
  // company-identity check downstream.
  return recordList(item.experience)
    .map((entry) => stringValue(entry.companyName))
    .find(Boolean) ?? null;
}

/**
 * Deliberately does not fall back to `headline`. thirdwatch fills headline with SEO
 * boilerplate ("Experience: X · Education: Y · View ...'s profile on LinkedIn"), and that
 * text would end up addressed to a real person inside an outreach draft.
 */
function currentTitle(item: Record_) {
  const direct = stringValue(item.currentTitle);
  if (direct) return direct;

  const present = recordList(item.experience).find((entry) => {
    const endDate = record(entry.endDate);
    return stringValue(endDate?.text, 100)?.toLowerCase() === "present";
  });
  const fromExperience = stringValue(present?.position);
  if (fromExperience) return fromExperience;

  const positions = recordList(item.currentPositions);
  const current = positions.find((entry) => entry.current === true) ?? positions[0];
  return (
    stringValue(current?.title) ??
    recordList(item.experience)
      .map((entry) => stringValue(entry.position))
      .find(Boolean) ??
    null
  );
}

function displayLocation(item: Record_) {
  const direct = stringValue(item.location);
  if (direct) return direct;
  return stringValue(record(item.location)?.linkedinText);
}

/**
 * The actor's location input behaves as a hint rather than a filter, so results include
 * people outside the target region. Rather than discard profiles we paid for, they are
 * ranked below local ones and the caller reports how many are non-local.
 */
export function isGreaterVancouver(location: string | null) {
  return location
    ? /vancouver|british columbia|\bb\.?c\.?\b|burnaby|surrey|richmond|coquitlam/i.test(
        location,
      )
    : false;
}

/**
 * Observed in real data: the actor sometimes puts the employer name in the title field.
 * A title that merely repeats the company is not a role, and letting it through would
 * address a real person as "Apply Digital at Apply Digital" in an outreach draft.
 */
function isUsableTitle(title: string, currentCompany: string) {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalize(title) !== normalize(currentCompany);
}

function fullName(item: Record_) {
  const first = stringValue(item.firstName, 200);
  const last = stringValue(item.lastName, 200);
  const joined = [first, last].filter(Boolean).join(" ");
  return joined || stringValue(item.fullName, 400);
}

/**
 * Only a school entry naming Simon Fraser explicitly counts. "alumni" additionally
 * requires a finished end year, so a current student is reported as "education" rather
 * than being described as a graduate in outreach copy.
 */
function sfuDetails(item: Record_) {
  const education = recordList(item.education);
  const sfu = education.find((entry) => {
    const schoolName = stringValue(entry.schoolName, 300) ?? stringValue(entry.school, 300);
    return schoolName
      ? schoolName.toLowerCase().includes("simon fraser university")
      : false;
  });

  if (!sfu) return { sfuConnection: null, sfuEvidence: null } as const;

  const endDate = record(sfu.endDate);
  const endYear = typeof endDate?.year === "number" ? endDate.year : null;
  // thirdwatch uses degreeName; harvestapi uses degree.
  const degree = stringValue(sfu.degreeName, 300) ?? stringValue(sfu.degree, 300);
  // thirdwatch omits endDate.text, so fall back to the year.
  const endText =
    stringValue(endDate?.text, 100) ?? (endYear !== null ? String(endYear) : null);

  return {
    sfuConnection:
      endYear !== null && endYear < new Date().getUTCFullYear()
        ? ("alumni" as const)
        : ("education" as const),
    sfuEvidence: `LinkedIn education lists Simon Fraser University${degree ? ` (${degree})` : ""}${endText ? ` ending ${endText}` : ""}.`,
  };
}

export type RejectionReason =
  | "not_an_object"
  | "no_profile_url"
  | "no_current_company"
  | "company_mismatch"
  | "no_name"
  | "no_title"
  | "title_repeats_company";

/**
 * `rejections` optionally collects why each record was dropped. Every profile is billed
 * whether or not it survives, so the caller can report the breakdown instead of leaving a
 * low yield looking like an empty search.
 */
/**
 * Apollo's people search returns structured employment data but carries no education
 * history, so `sfuConnection` is always null here. An SFU tie for an Apollo-discovered
 * contact can only come from cross-referencing an education-bearing provider.
 *
 * NOTE: written against Apollo's documented response shape. The endpoint is gated behind
 * a paid plan, so this mapping has not been exercised against a live payload — if Apollo
 * returns different field names, callers surface a loud error rather than an empty list.
 */
export function normalizeApolloPerson(
  value: unknown,
  expectedCompany: string,
  accessedAt: string,
  rejections?: RejectionReason[],
): EmployeeCandidate | null {
  const reject = (reason: RejectionReason) => {
    rejections?.push(reason);
    return null;
  };

  const item = record(value);
  if (!item) return reject("not_an_object");

  const linkedinUrl = validLinkedInUrl(item.linkedin_url) ? item.linkedin_url : null;
  if (!linkedinUrl) return reject("no_profile_url");

  const employment = recordList(item.employment_history);
  const currentRole = employment.find((entry) => entry.current === true);
  const currentCompany =
    stringValue(record(item.organization)?.name) ??
    stringValue(item.organization_name) ??
    stringValue(currentRole?.organization_name);

  if (!currentCompany) return reject("no_current_company");
  if (!isSameCompanyName(expectedCompany, currentCompany)) {
    return reject("company_mismatch");
  }

  const name =
    stringValue(item.name, 400) ??
    [stringValue(item.first_name, 200), stringValue(item.last_name, 200)]
      .filter(Boolean)
      .join(" ");
  const title = stringValue(item.title) ?? stringValue(currentRole?.title);

  if (!name) return reject("no_name");
  if (!title) return reject("no_title");
  if (!isUsableTitle(title, currentCompany)) return reject("title_repeats_company");

  const composedLocation = [
    stringValue(item.city, 100),
    stringValue(item.state, 100),
    stringValue(item.country, 100),
  ]
    .filter(Boolean)
    .join(", ");
  const location =
    stringValue(item.present_raw_address, 300) ?? (composedLocation || null);

  return {
    name,
    title,
    currentCompany,
    currentEmploymentEvidence: `Apollo lists ${currentCompany} as the current employer.`,
    linkedinUrl,
    location,
    sourceUrl: linkedinUrl,
    accessedAt,
    rolePriority: rolePriority(title),
    sfuConnection: null,
    sfuEvidence: null,
  };
}

export function normalizeEmployee(
  value: unknown,
  expectedCompany: string,
  accessedAt: string,
  rejections?: RejectionReason[],
): EmployeeCandidate | null {
  const reject = (reason: RejectionReason) => {
    rejections?.push(reason);
    return null;
  };

  const item = record(value);
  if (!item) return reject("not_an_object");

  const linkedinUrl = profileUrl(item);
  if (!linkedinUrl) return reject("no_profile_url");

  const currentCompany = currentEmployer(item);
  if (!currentCompany) return reject("no_current_company");
  if (!isSameCompanyName(expectedCompany, currentCompany)) {
    return reject("company_mismatch");
  }

  const name = fullName(item);
  const title = currentTitle(item);
  if (!name) return reject("no_name");
  if (!title) return reject("no_title");
  if (!isUsableTitle(title, currentCompany)) return reject("title_repeats_company");

  const { sfuConnection, sfuEvidence } = sfuDetails(item);

  return {
    name,
    title,
    currentCompany,
    currentEmploymentEvidence: `Current position lists ${currentCompany}.`,
    linkedinUrl,
    location: displayLocation(item),
    sourceUrl: linkedinUrl,
    accessedAt,
    rolePriority: rolePriority(title),
    sfuConnection,
    sfuEvidence,
  };
}
