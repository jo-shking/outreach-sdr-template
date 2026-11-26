import { rolePriority } from "./employee-normalize.ts";

export type MonetaryProvider = "Apollo" | "Apify" | "Clay" | "Orange Slice" | "Hunter" | "Official directory" | "GetProspect" | "Prospeo";
export type MonetaryEmailSource = "Hunter" | "Prospeo" | "GetProspect";

export function canUseApifyFreeAllowance(cap: unknown, used: unknown, maxRunUsd: number) {
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 && cap <= 5 &&
    typeof used === "number" && Number.isFinite(used) && used >= 0 &&
    Number.isFinite(maxRunUsd) && maxRunUsd > 0 && used + maxRunUsd <= cap;
}
export type MonetaryContact = {
  name: string; company: string; title: string; location: string;
  linkedinUrl: string | null; workEmail: string | null; sfuAlumni: boolean;
  emailVerification?: "verified";
  emailSource?: MonetaryEmailSource;
  provider: MonetaryProvider;
  sourceUrl?: string;
  icpMatch?: boolean;
  department?: string;
};
export type VerifiedMonetaryContact = MonetaryContact & {
  workEmail: string; emailVerification: "verified";
};
export const MONETARY_CONTACT_LIMIT = 5;
const ICP_DEPARTMENTS = new Set(["hr", "communication", "marketing", "education", "management"]);

export function compareMonetaryFit(a: MonetaryContact, b: MonetaryContact) {
  return Number(b.icpMatch !== false) - Number(a.icpMatch !== false) ||
    Number(ICP_DEPARTMENTS.has(b.department ?? "")) - Number(ICP_DEPARTMENTS.has(a.department ?? "")) ||
    rolePriority(b.title) - rolePriority(a.title) ||
    Number(b.sfuAlumni) - Number(a.sfuAlumni);
}

export type HunterSearchCounts = {
  returned: number;
  noNamedPerson: number;
  outsideIcp: number;
  emailMissing: number;
  wrongOrInvalidAddress: number;
  catchAll: number;
  unverified: number;
  outsideCompanyScope: number;
};

export type MonetaryWebsite = {
  domain: string;
  evidenceUrl?: string;
  location?: string;
  locationEvidence?: string;
  reasons?: string[];
};

export function hasVerifiedWorkEmail(contact: MonetaryContact): contact is VerifiedMonetaryContact {
  // Adapters may populate workEmail only with a provider-verified work address.
  return contact.emailVerification === "verified" &&
    typeof contact.workEmail === "string" && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(contact.workEmail);
}
export type ProviderOutcome = {
  state: "skipped" | "quota" | "empty" | "profiles" | "found" | "unavailable";
  message?: string;
  contacts?: MonetaryContact[];
  hunterCounts?: HunterSearchCounts;
  website?: MonetaryWebsite;
  websiteCandidates?: MonetaryWebsite[];
};
export type MonetarySearchResult = {
  contacts: VerifiedMonetaryContact[];
  profileOnly: MonetaryContact[];
  additionalContacts: MonetaryContact[];
  attempts: Array<Omit<ProviderOutcome, "contacts"> & { provider: MonetaryProvider }>;
};

export async function runMonetaryWaterfall(
  providers: ReadonlyArray<{ name: MonetaryProvider; lookup: (contacts: readonly MonetaryContact[]) => Promise<ProviderOutcome> }>,
): Promise<MonetarySearchResult> {
  const attempts: MonetarySearchResult["attempts"] = [];
  const contacts: MonetaryContact[] = [];
  for (const { name, lookup } of providers) {
    let result: ProviderOutcome;
    try {
      result = await lookup(contacts);
    } catch {
      result = { state: "unavailable", message: "Provider could not complete the search." };
    }
    attempts.push({ provider: name, state: result.state, message: result.message,
      ...(result.hunterCounts && { hunterCounts: result.hunterCounts }),
      ...(result.website && { website: result.website }),
      ...(result.websiteCandidates && { websiteCandidates: result.websiteCandidates }),
    });
    for (const contact of result.contacts ?? []) {
      const cleanUrl = (url: string | null) => url?.toLowerCase().replace(/^https:\/\/(?:[^/]+\.)?linkedin\.com/, "").replace(/\/$/, "");
      const match = contacts.findIndex((existing) =>
        (contact.linkedinUrl && cleanUrl(contact.linkedinUrl) === cleanUrl(existing.linkedinUrl)) ||
        (existing.name.toLowerCase() === contact.name.toLowerCase() &&
          existing.company.toLowerCase() === contact.company.toLowerCase()),
      );
      if (match < 0) contacts.push(contact);
      else {
        const existing = contacts[match];
        if (existing.icpMatch === false && contact.icpMatch !== false) {
          contacts[match] = hasVerifiedWorkEmail(existing)
            ? { ...contact, workEmail: existing.workEmail, emailVerification: "verified",
              emailSource: existing.emailSource ?? (existing.provider === "Hunter" ? "Hunter" : undefined) }
            : contact;
        } else if (hasVerifiedWorkEmail(contact) && !hasVerifiedWorkEmail(existing)) {
          contacts[match] = { ...existing, workEmail: contact.workEmail, emailVerification: "verified",
            emailSource: contact.emailSource ?? (contact.provider === "Hunter" ? "Hunter" : undefined),
          };
        }
      }
    }
    if (contacts.some((contact) => contact.icpMatch !== false && hasVerifiedWorkEmail(contact))) break;
  }
  return { attempts, ...groupMonetaryContacts(contacts) };
}

export function groupMonetaryContacts(contacts: readonly MonetaryContact[]) {
  const ranked = [...contacts].sort(compareMonetaryFit);
  const seenEmails = new Set<string>();
  const counted: VerifiedMonetaryContact[] = [];
  const profileOnly: MonetaryContact[] = [];
  const additionalContacts: MonetaryContact[] = [];
  for (const contact of ranked) {
    if (contact.icpMatch === false) {
      additionalContacts.push(contact);
    } else if (!hasVerifiedWorkEmail(contact)) {
      profileOnly.push({ ...contact, workEmail: null, emailVerification: undefined });
    } else {
      const email = contact.workEmail.toLowerCase();
      if (counted.length < MONETARY_CONTACT_LIMIT && !seenEmails.has(email)) {
        seenEmails.add(email);
        counted.push(contact);
      } else {
        additionalContacts.push(contact);
      }
    }
  }
  return {
    contacts: counted, profileOnly, additionalContacts,
  };
}
