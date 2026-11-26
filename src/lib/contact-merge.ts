// Merges contacts discovered by more than one provider. Apollo's people search returns
// structured employment data but no education history, so it cannot detect an SFU
// connection on its own; Apify returns education. Cross-referencing the two lets Apollo
// supply breadth while Apify supplies the SFU signal.
import type { EmployeeCandidate } from "./employee-normalize.ts";
import { isGreaterVancouver, isTargetRole } from "./employee-normalize.ts";

export type ContactSource = "Apollo" | "Apify";

export type DiscoveredContact = EmployeeCandidate & {
  sources: ContactSource[];
};

/**
 * Two providers spell the same profile differently — trailing slashes, http vs https,
 * regional subdomains like ca.linkedin.com, tracking parameters. Without a canonical
 * form the same person appears twice.
 */
export function canonicalProfile(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return null;

    const match = parsed.pathname.match(/^\/in\/([^/]+)/i);
    if (!match) return null;

    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
}

function preferLonger(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

/**
 * Combines one record per person. Where the providers disagree, the field is taken from
 * whichever actually has it: Apify wins on SFU data because Apollo does not carry
 * education, and a present value always beats a missing one.
 */
function combine(
  existing: DiscoveredContact,
  incoming: EmployeeCandidate,
  source: ContactSource,
): DiscoveredContact {
  return {
    ...existing,
    // A verified SFU connection from either provider is kept; only one of them can see it.
    sfuConnection: existing.sfuConnection ?? incoming.sfuConnection,
    sfuEvidence: existing.sfuEvidence ?? incoming.sfuEvidence,
    location: existing.location ?? incoming.location,
    // Titles vary in specificity between providers; the longer one is usually the fuller
    // one ("Director, Talent Acquisition" over "Director").
    title: preferLonger(existing.title, incoming.title) ?? existing.title,
    rolePriority: Math.max(existing.rolePriority, incoming.rolePriority),
    currentEmploymentEvidence: [
      existing.currentEmploymentEvidence,
      incoming.currentEmploymentEvidence,
    ]
      .filter(Boolean)
      .join(" "),
    sources: existing.sources.includes(source)
      ? existing.sources
      : [...existing.sources, source],
  };
}

/**
 * Ranks and de-duplicates contacts from every provider. Contacts without an SFU
 * connection are kept — they are still valid people to approach — they simply rank below
 * those with one.
 */
export function mergeContacts(
  groups: ReadonlyArray<{ source: ContactSource; contacts: readonly EmployeeCandidate[] }>,
): DiscoveredContact[] {
  const byProfile = new Map<string, DiscoveredContact>();

  for (const { source, contacts } of groups) {
    for (const contact of contacts) {
      const key = canonicalProfile(contact.linkedinUrl);
      if (!key) continue;

      const existing = byProfile.get(key);
      byProfile.set(
        key,
        existing
          ? combine(existing, contact, source)
          : { ...contact, sources: [source] },
      );
    }
  }

  const sfuRank = (contact: DiscoveredContact) =>
    contact.sfuConnection === "alumni"
      ? 2
      : contact.sfuConnection === "education"
        ? 1
        : 0;

  // Holding one of MISA's target roles outranks an SFU connection: a campus recruiter
  // with no SFU tie is a better first approach than an SFU alumnus in an unrelated job.
  // Within the target-role group, an SFU connection breaks the tie.
  return [...byProfile.values()].sort(
    (a, b) =>
      Number(isTargetRole(b.rolePriority)) - Number(isTargetRole(a.rolePriority)) ||
      sfuRank(b) - sfuRank(a) ||
      Number(isGreaterVancouver(b.location)) - Number(isGreaterVancouver(a.location)) ||
      b.rolePriority - a.rolePriority ||
      a.name.localeCompare(b.name),
  );
}
