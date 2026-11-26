import { parse } from "tldts";
import { isRecruitingPlatformHost } from "./company-domain.ts";
import { directorySite } from "./official-directory-http.ts";

const RECRUITING_SUBDOMAINS = new Set(["career", "careers", "job", "jobs", "recruiting", "talent"]);

export function monetaryDomainFromWebsite(website: string | null) {
  const site = directorySite(website);
  if (!site) return "";
  const host = site.hostname.replace(/^www\./i, "");
  if (isRecruitingPlatformHost(host)) return "";
  const { domain, isPrivate, subdomain } = parse(host, { allowPrivateDomains: true });
  if (!domain) return "";
  if (!subdomain?.split(".").some((label) => RECRUITING_SUBDOMAINS.has(label))) return host;
  // Keep lookup scope within the organization and avoid climbing shared hosting suffixes.
  return !isPrivate ? domain : "";
}
