import "server-only";

import {
  ApolloConfigurationError,
  findCompanyPeople,
  resolveCompanyDomain,
} from "@/lib/apollo";
import { findCompanyEmployees } from "@/lib/apify";
import { mergeContacts, type DiscoveredContact } from "@/lib/contact-merge";
import {
  normalizeApolloPreview,
  rankApolloPreviews,
  type ApolloPreview,
} from "@/lib/apollo-preview";

const APOLLO_PER_PAGE = 25;
const APOLLO_LOCATIONS = ["Vancouver, Canada", "British Columbia, Canada"];

function companyDomain(website: string | null) {
  if (!website) return null;

  try {
    const url = new URL(
      website.startsWith("http") ? website : `https://${website}`,
    );
    return url.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Runs both providers and cross-references them. Apollo supplies breadth cheaply (its
 * search consumes no credits) but carries no education history; Apify supplies the SFU
 * signal. Either provider failing leaves the other's results intact, because a partial
 * contact list is far more useful than an error.
 */
export async function discoverContacts({
  companyName,
  linkedinCompanyUrl,
  website,
}: {
  companyName: string;
  linkedinCompanyUrl: string | null;
  website: string | null;
}) {
  const limitations: string[] = [];
  // Free sources first: the sheet's website, or the domain Exa inferred during research.
  // Only fall back to Apollo's paid lookup when neither is available.
  let domain = companyDomain(website);

  if (!domain) {
    const resolved = await resolveCompanyDomain(companyName);

    if (resolved) {
      domain = resolved.domain;
      limitations.push(
        `No website was on file, so Apollo resolved "${companyName}" to ${resolved.domain} (matched "${resolved.matchedName}") for 1 credit. Adding the website to the sheet avoids that charge next time.`,
      );
    } else {
      // Apollo's name search is genuinely unreliable — searching "Apply Digital" returns
      // two subsidiaries and an unrelated two-person firm before the real company — so a
      // rejected match here is the guard working, not a failure to try.
      limitations.push(
        `Apollo needs a company domain and none was available: the sheet has no website, and Apollo could not confidently match the name "${companyName}" to a single company. Research this account first — that reliably identifies the domain — or add the website to the sheet.`,
      );
    }
  }

  const [apolloResult, apifyResult] = await Promise.allSettled([
    domain
      ? findCompanyPeople({
          companyDomain: domain,
          personLocations: APOLLO_LOCATIONS,
          perPage: APOLLO_PER_PAGE,
        })
      : // The reason was already recorded above, so keep this quiet rather than
        // reporting the same missing domain twice.
        Promise.resolve({ people: [], total: 0 }),
    findCompanyEmployees(companyName, linkedinCompanyUrl),
  ]);

  let previews: ApolloPreview[] = [];

  if (apolloResult.status === "fulfilled") {
    // Apollo withholds surnames, emails and LinkedIn URLs until a credit is spent, so
    // these stay previews. Titles arrive free, which is enough to rank them.
    previews = rankApolloPreviews(
      apolloResult.value.people
        .map(normalizeApolloPreview)
        .filter((preview): preview is ApolloPreview => Boolean(preview)),
    );

    const withoutEmail = previews.filter((preview) => !preview.hasEmail).length;

    if (previews.length > 0 && withoutEmail > 0) {
      limitations.push(
        `${withoutEmail} of ${previews.length} Apollo contacts have no email on file; revealing them would cost a credit and return no address.`,
      );
    }

    // Only worth saying when Apollo actually returned people; a skipped search already
    // explained itself above.
    if (previews.length === 0 && apolloResult.value.people.length > 0) {
      limitations.push(
        `Apollo returned ${apolloResult.value.people.length} people but none had both a usable id and a job title.`,
      );
    }
  } else {
    const reason =
      apolloResult.reason instanceof ApolloConfigurationError
        ? "Apollo is not configured on the server."
        : apolloResult.reason instanceof Error
          ? apolloResult.reason.message
          : "Apollo lead search failed.";
    // Apollo being unavailable is expected on a trial plan, so it is reported as a
    // limitation rather than failing the whole search.
    limitations.push(`Apollo lead search unavailable: ${reason}`);
  }

  if (apifyResult.status === "rejected") {
    const reason =
      apifyResult.reason instanceof Error
        ? apifyResult.reason.message
        : "Apify employee search failed.";

    // If Apollo produced nothing either, there is nothing to show at all.
    if (previews.length === 0) {
      throw apifyResult.reason;
    }

    limitations.push(`Apify employee search unavailable: ${reason}`);
  }

  const apifyContacts =
    apifyResult.status === "fulfilled" ? apifyResult.value.employees : [];
  const contacts: DiscoveredContact[] = mergeContacts([
    { source: "Apify", contacts: apifyContacts },
  ]);

  return {
    companyName,
    // The domain is echoed back so a reveal can verify against the same one searched.
    companyDomain: domain,
    employees: contacts,
    previews,
    limitations: [
      ...(apifyResult.status === "fulfilled" ? apifyResult.value.limitations : []),
      ...limitations,
      ...(contacts.length > 0 && !contacts.some((c) => c.sfuConnection)
        ? [
            "No contact here has a verified SFU connection. They are still valid people to approach; drafts simply will not reference SFU.",
          ]
        : []),
    ],
  };
}
