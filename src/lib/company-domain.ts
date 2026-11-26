// Infers a company's own domain from research sources. Apollo's people search is
// domain-based, so accounts with a blank Website column cannot be searched at all — but
// Exa research has already visited the company's real site by then. Deriving the domain
// here costs nothing, whereas Apollo's organizations/search charges a credit per lookup
// and those credits are needed for email enrichment.

const RECRUITING_PLATFORM_HOSTS = [
  "glassdoor.com", "glassdoor.ca", "indeed.com", "ziprecruiter.com", "lever.co",
  "greenhouse.io", "workable.com", "bamboohr.com", "myworkdayjobs.com",
  "virtualvocations.com", "builtin.com", "wellfound.com",
];

// Directories, job boards, news wires and social networks appear in research sources but
// are never the company's own domain.
const NON_COMPANY_HOSTS = [
  "linkedin.com",
  "crunchbase.com",
  "cbinsights.com",
  "pitchbook.com",
  "zoominfo.com",
  "rocketreach.co",
  "apollo.io",
  ...RECRUITING_PLATFORM_HOSTS,
  "wikipedia.org",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "medium.com",
  "github.com",
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "newswire.ca",
  "reuters.com",
  "bloomberg.com",
  "forbes.com",
  "techcrunch.com",
  "betakit.com",
  "yahoo.com",
  "google.com",
  "vertexaisearch.cloud.google.com",
];

function hostOf(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function isRecruitingPlatformHost(host: string) {
  return RECRUITING_PLATFORM_HOSTS.some((platform) => host === platform || host.endsWith(`.${platform}`));
}

function isCompanyHost(host: string) {
  return !NON_COMPANY_HOSTS.some(
    (blocked) => host === blocked || host.endsWith(`.${blocked}`),
  );
}

/** "Apply Digital Inc." -> "applydigital", so it can be compared against a domain label. */
function squash(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|group|holdings|technologies|technology|solutions|consulting|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** The domain label without its public suffix: "itsconsultinginc.ca" -> "itsconsultinginc". */
function domainLabel(host: string) {
  return host.split(".")[0] ?? host;
}

/**
 * Picks the most likely official domain from a set of research source URLs. A name match
 * against the domain is trusted first, because it is the strongest signal; otherwise the
 * most frequently cited company-looking host wins.
 *
 * A wrong guess is safe rather than harmful: Apollo results are still verified against
 * the expected company name, so a mismatched domain yields rejected candidates rather
 * than contacts at the wrong company.
 */
export function inferCompanyDomain(
  sourceUrls: readonly string[],
  companyName: string,
): string | null {
  const hosts = sourceUrls
    .map(hostOf)
    .filter((host): host is string => Boolean(host) && isCompanyHost(host!));

  if (hosts.length === 0) return null;

  const wanted = squash(companyName);

  if (wanted.length >= 3) {
    const named = hosts.find((host) => {
      const label = squash(domainLabel(host));
      return (
        label === wanted || label.startsWith(wanted) || wanted.startsWith(label)
      );
    });
    if (named) return named;
  }

  const counts = new Map<string, number>();
  for (const host of hosts) counts.set(host, (counts.get(host) ?? 0) + 1);

  return (
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].length - b[0].length,
    )[0]?.[0] ?? null
  );
}
