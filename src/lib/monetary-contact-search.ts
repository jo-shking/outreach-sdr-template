import "server-only";

import { findCompanyEmployees } from "./apify";
import { findCompanyPeople } from "./apollo";
import { normalizeApolloPreview, rankApolloPreviews } from "./apollo-preview";
import { isGreaterVancouver, rolePriority } from "./employee-normalize";
import { configuredExaCompanyDomain } from "./exa-company-domain";
import type { Account } from "./google-sheets";
import { discoverHunterContacts } from "./hunter-discovery";
import { reserveMonetaryLookup } from "./monetary-budget";
import { CHANG_TEAM_SOURCE, isChangInstituteAccount, isMonetaryTargetRole } from "./monetary-directory";
import { monetaryDomainFromWebsite } from "./monetary-domain";
import { monetaryProviderCredential } from "./monetary-provider-env";
import { discoverGetProspectContacts, discoverProspeoContacts } from "./monetary-provider-fallbacks";
import { canUseApifyFreeAllowance, runMonetaryWaterfall, type MonetaryContact, type MonetaryWebsite, type ProviderOutcome } from "./monetary-waterfall";
import { directorySite, readDirectoryPage } from "./official-directory-http";
import { directoryLinks, isDirectoryPagePath, readDirectoryPeople } from "./official-directory-parse";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
    value as Record<string, unknown> : {};
}

export function monetaryCompanyDomain(website: string | null, companyName?: string) {
  if (isChangInstituteAccount(companyName)) return monetaryDomainFromWebsite(CHANG_TEAM_SOURCE);
  return monetaryDomainFromWebsite(website);
}

function classify(error: unknown): ProviderOutcome {
  const { status } = record(error);
  if (status === 402 || status === 429) return { state: "quota", message: "Provider credits or rate limit reached." };
  if (status === 401 || status === 403) return { state: "unavailable", message: "Provider account or key is not eligible for this lookup." };
  return { state: "unavailable", message: "Provider or budget check could not complete the lookup." };
}

function outcome(contacts: MonetaryContact[]): ProviderOutcome {
  return { state: contacts.some((item) => item.workEmail) ? "found" : contacts.length ? "profiles" : "empty", contacts };
}

const APIFY_MAX_USD = 0.20;

async function findDirectoryProfiles(companyName: string, website: string | null) {
  const chang = isChangInstituteAccount(companyName);
  const site = directorySite(chang ? CHANG_TEAM_SOURCE : website);
  if (!site) return null;
  const main = await readDirectoryPage(site);
  const pages = [main];

  function contactsFrom(page: typeof main, directoryPage: boolean): MonetaryContact[] {
    return readDirectoryPeople(page.html, { chang, directoryPage }).map((person) => ({
        ...person, company: companyName, location: chang ? "Official directory" : "Location not verified",
        linkedinUrl: null, workEmail: null, sfuAlumni: false, provider: "Official directory",
        sourceUrl: page.url.href, icpMatch: chang || isMonetaryTargetRole(person.title),
      }));
  }

  const people = contactsFrom(main, isDirectoryPagePath(main.url.pathname));
  if (!chang && !people.some(({ icpMatch }) => icpMatch)) {
    const links = directoryLinks(main.html, main.url);
    const results = await Promise.allSettled(links.map(({ url }) => readDirectoryPage(site, url)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        pages.push(result.value);
        people.push(...contactsFrom(result.value, links[index].rank > 0));
      }
    });
    if (!people.some(({ icpMatch }) => icpMatch)) {
      const visited = new Set(pages.map(({ url }) => url.href));
      const teamLink = pages.slice(1).flatMap(({ html, url }) => directoryLinks(html, url))
        .find(({ url, rank }) => rank > 0 && !visited.has(url.href));
      if (teamLink) {
        const team = await readDirectoryPage(site, teamLink.url).catch(() => null);
        if (team) people.push(...contactsFrom(team, true));
      }
    }
  }

  const unique = new Map(people.map((person) => [person.name.toLowerCase(), person]));
  return [...unique.values()].sort((a, b) => {
    if (chang) {
      const incubatorOrder = Number(/\bincubat/i.test(b.title)) - Number(/\bincubat/i.test(a.title));
      if (incubatorOrder) return incubatorOrder;
    }
    return Number(b.icpMatch) - Number(a.icpMatch) || rolePriority(b.title) - rolePriority(a.title);
  }).slice(0, 10);
}

export function findMonetaryContacts(companyName: string, account: Account, chosenWebsite?: MonetaryWebsite | null) {
  const trackerSite = directorySite(account.website);
  const trackerDomain = monetaryDomainFromWebsite(account.website);
  const domain = monetaryCompanyDomain(account.website, companyName) || chosenWebsite?.domain || "";
  let website = trackerDomain && trackerSite
    ? trackerSite.hostname.replace(/^www\./i, "") === trackerDomain ? trackerSite.href : `https://${trackerDomain}/`
    : chosenWebsite?.evidenceUrl ?? null;
  const chang = isChangInstituteAccount(companyName);
  const enabled = new Set((process.env.MONETARY_ENABLED_PROVIDERS ?? "")
    .split(",").map((value) => value.trim().toLowerCase()));

  let foundProfiles = false;
  let searchDomain = domain;
  let needsWebsiteChoice = false;
  let prospeoSearchLimited = false;
  let directory: ReturnType<typeof findDirectoryProfiles> | undefined;
  const getDirectory = () => directory ??= findDirectoryProfiles(companyName, website);
  const officialDirectory = { name: "Official directory" as const, async lookup(): Promise<ProviderOutcome> {
    try {
      const contacts = await getDirectory();
      if (!contacts) return { state: "skipped", message: "No official website is available in the tracker." };
      foundProfiles = contacts.some(({ icpMatch }) => icpMatch !== false);
      return { ...outcome(contacts), message: foundProfiles ? undefined : "No target roles were listed on the pages checked." };
    } catch {
      return { state: "unavailable", message: "The official directory could not be read." };
    }
  } };
  const hunter = { name: "Hunter" as const, async lookup(): Promise<ProviderOutcome> {
    const result = await discoverHunterContacts({
      companyName, domain, key: process.env.HUNTER_API_KEY?.trim(), sharedDomain: chang,
      findWebsite: () => configuredExaCompanyDomain(companyName, account),
    });
    searchDomain = result.website?.domain || domain;
    needsWebsiteChoice = Boolean(result.websiteCandidates?.length);
    if (!website && result.website?.evidenceUrl) website = result.website.evidenceUrl;
    if (!chang || !result.contacts?.length) return chosenWebsite ? { ...result, website: chosenWebsite } : result;

    // sfu.ca serves the entire university. Only show people listed by the selected institute.
    const listed = await getDirectory().catch(() => null);
    const byName = new Map((listed ?? []).map((person) => [person.name.toLowerCase(), person]));
    const contacts = result.contacts.flatMap((contact) => {
      const match = byName.get(contact.name.toLowerCase());
      return match ? [{ ...contact, title: match.title, location: match.location, sourceUrl: match.sourceUrl }] : [];
    });
    return {
      ...outcome(contacts),
      website: result.website,
      ...(result.hunterCounts && { hunterCounts: {
        ...result.hunterCounts, outsideCompanyScope: result.contacts.length - contacts.length,
      } }),
      message: contacts.length ? "Matched against the institute's official directory."
        : "Hunter returned no people we could match to the institute's directory.",
    };
  } };
  const nameProviders = (["GetProspect", "Prospeo"] as const).map((name) => ({
    name,
    key: name === "GetProspect" ? process.env.GETPROSPECT_API_KEY?.trim() : process.env.PROSPEO_API_KEY?.trim(),
    discover: name === "GetProspect" ? discoverGetProspectContacts : discoverProspeoContacts,
  }));
  const nameFallbacks = [true, false].flatMap((targetOnly) => nameProviders.map(({ name, key, discover }) => ({
    name,
    async lookup(people: readonly MonetaryContact[]): Promise<ProviderOutcome> {
      const named = people.filter(({ name }) => /^\S+\s+\S/.test(name.trim()) && !/[*•]/.test(name));
      if (named.some(({ icpMatch }) => icpMatch !== false)) {
        return { state: "skipped", message: "The search already found people in target roles." };
      }
      if (!targetOnly && name === "Prospeo" && named.length) {
        return { state: "skipped", message: "Other contacts are already available." };
      }
      if (needsWebsiteChoice) return { state: "skipped", message: "Choose the company website before searching for names." };
      if (name === "Prospeo" && prospeoSearchLimited) {
        return { state: "skipped", message: "All roles. Skipped after the earlier Prospeo limit." };
      }
      const result = await discover({ companyName, domain: chang ? "" : searchDomain, key, targetOnly });
      if (name === "Prospeo" && result.state === "quota") prospeoSearchLimited = true;
      foundProfiles ||= Boolean(result.contacts?.some(({ icpMatch }) => icpMatch !== false));
      return { ...result, message: `${targetOnly ? "Target roles" : "All roles"}. ${result.message ?? ""}`.trim() };
    },
  })));
  if (chang) return runMonetaryWaterfall([hunter, officialDirectory, ...nameFallbacks]);

  return runMonetaryWaterfall([
    hunter,
    officialDirectory,
    ...nameFallbacks,
    { name: "Apollo", async lookup() {
      if (foundProfiles) return { state: "skipped", message: "The search already found people in target roles." };
      if (!enabled.has("apollo")) {
        return { state: "skipped", message: "Apollo is not enabled for Monetary." };
      }
      const key = monetaryProviderCredential("apollo", process.env);
      if (!key) return { state: "skipped", message: "No Apollo credential found in this deployment." };
      if (!domain) return { state: "skipped", message: "No company domain; paid domain lookup is off." };
      try {
        const result = await findCompanyPeople({
          companyDomain: domain, personLocations: ["Vancouver, Canada", "British Columbia, Canada"], perPage: 10,
        }, key);
        const previews = rankApolloPreviews(result.people.map(normalizeApolloPreview)
          .filter((preview) => preview !== null));
        if (!previews.length) return { state: "empty" };
        return { state: "profiles", message: "Only masked previews. Paid reveals are disabled." };
      } catch (error) {
        return classify(error);
      }
    } },
    { name: "Apify", async lookup() {
      if (foundProfiles) return { state: "skipped", message: "The search already found people in target roles." };
      if (!enabled.has("apify")) {
        return { state: "skipped", message: "Apify is not enabled for Monetary." };
      }
      const token = monetaryProviderCredential("apify", process.env);
      if (!token) return { state: "skipped", message: "No Apify credential found in this deployment." };
      try {
        const limits = await fetch("https://api.apify.com/v2/users/me/limits", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store", signal: AbortSignal.timeout(5_000),
        });
        if (!limits.ok) return { state: "skipped", message: "Apify free usage limit could not be verified." };
        const account = record(record(await limits.json()).data);
        const cap = record(account.limits).maxMonthlyUsageUsd;
        const used = record(account.current).monthlyUsageUsd;
        if (!canUseApifyFreeAllowance(cap, used, APIFY_MAX_USD)) {
          return { state: "quota", message: "Apify would exceed the free allowance or no safe account cap was found." };
        }
        if (!await reserveMonetaryLookup("Apify")) return { state: "quota", message: "Apify pilot cap reached." };
        const result = await findCompanyEmployees(companyName, null, {
          maxTotalChargeUsd: APIFY_MAX_USD, timeoutSeconds: 30,
        }, token);
        const contacts: MonetaryContact[] = result.employees.filter((person) =>
          person.location && isGreaterVancouver(person.location),
        ).sort((a, b) => rolePriority(b.title) - rolePriority(a.title))
          .map((person) => ({
            provider: "Apify", name: person.name, title: person.title, company: person.currentCompany,
            location: person.location!, linkedinUrl: person.linkedinUrl, workEmail: null,
            sfuAlumni: person.sfuConnection === "alumni", icpMatch: isMonetaryTargetRole(person.title),
          }));
        foundProfiles = contacts.some(({ icpMatch }) => icpMatch);
        return outcome(contacts);
      } catch (error) {
        return classify(error);
      }
    } },
    { name: "Clay", async lookup() {
      if (!enabled.has("clay")) return { state: "skipped", message: "Clay is not enabled for Monetary." };
      return { state: "skipped", message: "Clay API access is not included in the Free plan." };
    } },
    { name: "Orange Slice", async lookup() {
      return { state: "skipped", message: "Public API is pay per use. Skipped in free-only mode." };
    } },
  ]);
}
