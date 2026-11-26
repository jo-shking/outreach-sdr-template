import { load } from "cheerio";
import { isSameCompanyName } from "./company-identity.ts";
import { monetaryDomainFromWebsite } from "./monetary-domain.ts";
import type { Account } from "./google-sheets.ts";
import type { MonetaryWebsite } from "./monetary-waterfall.ts";
import { directorySite, isSameDirectorySite, readDirectoryPage } from "./official-directory-http.ts";

const METRO_VANCOUVER = "Greater Vancouver, British Columbia";
const METRO_LOCALITIES = /\b(?:vancouver|burnaby|surrey|richmond|coquitlam|port moody|port coquitlam|new westminster|langley|delta|white rock|pitt meadows|maple ridge|tsawwassen)\b/i;
const BC_OFFICE = new RegExp(`${METRO_LOCALITIES.source}[,\\s]+(?:british columbia|b\\.?c\\.?)\\b`, "i");
const CONTACT_PATH = /\/(?:contact(?:-us)?|locations?|offices)(?:[/.]|$)/i;
const FIT_PATH = /\/(?:about(?:-us)?|what-we-do|services|industries|[^/]*(?:engineering|technolog|innovation|communit|scholarship|sponsor|education|outreach)[^/]*)(?:[/.]|$)/i;
const TECH_WORK = /\b(?:software|robotics|automation|cybersecurity|semiconductors?|engineering|advanced manufacturing|industrial design|naval architecture|shipbuilding|aerospace|applied research|digital (?:platforms?|systems?)|product development|(?:technology|technical) (?:services|solutions|development))\b/i;
const STUDENT_GROUP = /\b(?:students?|student[- ]led|universit(?:y|ies)|colleges?|campus|scholarships?|bursar(?:y|ies)|hackathons?)\b/i;
const SPONSORSHIP = /\b(?:sponsor(?:ed|s|ing|ship|ships)?|fund(?:ed|s|ing)?|donat(?:e|ed|es|ion|ions)|grants?|scholarships?|bursar(?:y|ies))\b/i;
const GENERIC_NOTE_TERMS = new Set("about based british business canada canadian company companies community engineering group industry local located organization opportunities outreach partners partnership potential programs services sponsorship student students supports technical technology vancouver work works".split(" "));
const NON_ORGANIZATION_HOSTS = [
  "linkedin.com", "facebook.com", "instagram.com", "crunchbase.com", "wikipedia.org", "exa.ai",
  "webflow.io", "wixsite.com", "wordpress.com", "sites.google.com", "youtube.com", "linktr.ee",
  "github.io", "notion.site", "substack.com",
];

type WebsiteMatch = MonetaryWebsite & { evidenceUrl: string; location: string };

export type ExaDomainResult =
  | WebsiteMatch
  | { domain: ""; reason: "disabled" | "unavailable" | "unconfirmed" }
  | { domain: ""; reason: "ambiguous"; candidates: WebsiteMatch[] };

type ExaFailure = Extract<ExaDomainResult, { reason: string }>;

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function domainOf(url: URL) {
  return url.hostname.replace(/^www\./, "");
}

function normalizeLocation(value: string) {
  return value.toLowerCase().replace(/\bbritish columbia\b/g, "bc").replace(/\balberta\b/g, "ab")
    .replace(/\bontario\b/g, "on").replace(/\bb\.c\./g, "bc").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function matchesLocation(evidence: string, expected: string) {
  // For Metro Vancouver, require a local municipality paired with BC evidence.
  if (/^(?:greater vancouver|metro vancouver)(?:,|$)/i.test(expected)) {
    return BC_OFFICE.test(evidence.replace(/\n/g, ";"));
  }
  const parts = expected.split(",").map(normalizeLocation).filter(Boolean);
  return parts.length > 0 && evidence.split(/[\n;]+/).some((part) => {
    const normalized = ` ${normalizeLocation(part)} `;
    if (!normalized.includes(" bc ")) return false;
    if (parts.length === 1 && METRO_LOCALITIES.test(parts[0]) && !BC_OFFICE.test(part)) return false;
    return parts.every((expectedPart) => normalized.includes(` ${expectedPart} `));
  });
}

function pageEvidence(html: string, page: URL) {
  const $ = load(html);
  const names = [
    $('meta[property="og:site_name"]').attr("content"),
    $('meta[property="og:title"]').attr("content"),
    $("title").first().text(),
  ].flatMap((name) => text(name).split(/\s+[—–-]\s+|\|/).map(text).filter(Boolean));
  const locations: string[] = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = record(value);
    const valueType = node["@type"];
    const type = (Array.isArray(valueType) ? valueType : [valueType]).map(text);
    if (type.some((item) => /(?:Organization|LocalBusiness|Corporation)$/i.test(item))) {
      names.push(text(node.name), text(node.legalName), text(node.alternateName));
      if (typeof node.address === "string") locations.push(text(node.address));
      else visit(node.address);
    }
    if (type.some((item) => /PostalAddress$/i.test(item))) {
      locations.push([node.addressLocality, node.addressRegion, node.postalCode, node.addressCountry].map(text).join(" "));
    }
    if (node["@graph"]) visit(node["@graph"]);
  }
  $('script[type="application/ld+json"]').each((_, element) => {
    try { visit(JSON.parse($(element).text())); } catch { /* Ignore malformed website metadata. */ }
  });
  $("address, [itemprop='address'], footer p, footer li").each((_, element) => {
    $(element).find("br").replaceWith(" ");
    locations.push(text($(element).text()).slice(0, 1500));
  });
  if (CONTACT_PATH.test(page.pathname)) {
    $("main p, main li, main h2, main h3, [role='main'] p, [role='main'] li").each((_, element) => {
      locations.push(text($(element).text()).slice(0, 350));
    });
    // Nearby city and region may be rendered as separate elements in an office card.
    $("main section, main article").each((_, element) => {
      const location = text($(element).text());
      if (location.length <= 420) locations.push(location);
    });
    const main = text($("main, [role='main']").first().text());
    if (main.length <= 1000) locations.push(main);
  }
  const contactLinks = new Map<string, URL>();
  const fitLinks = new Map<string, URL>();
  $("a[href]").each((_, element) => {
    if (contactLinks.size >= 2 && fitLinks.size >= 8) return false;
    try {
      const url = new URL($(element).attr("href") ?? "", page);
      if (!isSameDirectorySite(url, page) || url.pathname === page.pathname) return;
      url.search = "";
      url.hash = "";
      if (CONTACT_PATH.test(url.pathname) && contactLinks.size < 2) contactLinks.set(url.href, url);
      if (FIT_PATH.test(url.pathname) && fitLinks.size < 8) fitLinks.set(url.href, url);
    } catch { /* Ignore malformed links. */ }
  });
  $("nav, header, footer, script, style, [hidden]").remove();
  const blocks = $("h1, h2, h3, p, li").slice(0, 100).map((_, element) =>
    text($(element).text()).slice(0, 600),
  ).get();
  return { names, locations: locations.join("\n"), blocks, contactLinks: [...contactLinks.values()], fitLinks: [...fitLinks.values()] };
}

function noteWords(value: string) {
  return new Set(value.toLowerCase().match(/\b[a-z][a-z-]{3,}\b/g) ?? []);
}

function fitScore(domain: string, blocks: string[], notes: string[], companyName: string) {
  const nameWords = noteWords(companyName);
  const noteDomains = notes.flatMap((note) => note.match(/https?:\/\/[^\s,;<>"]+/gi) ?? [])
    .map((url) => directorySite(url)).filter((url) => url !== null).map(domainOf);
  const noteTerms = noteWords(notes.join(" ").replace(/https?:\/\/[^\s,;<>"]+/gi, ""));
  const distinctive = [...noteTerms].filter((word) => !nameWords.has(word) && !GENERIC_NOTE_TERMS.has(word));
  const matchesNotes = blocks.some((block) => {
    const words = noteWords(block);
    return distinctive.filter((word) => words.has(word)).length >= 2;
  });
  // An exact tracker reference outranks text overlap. Specific tracker evidence outranks general fit.
  const signals = [
    { match: noteDomains.includes(domain), weight: 8, label: "Domain cited in the tracker" },
    { match: matchesNotes, weight: 4, label: "Matches details from tracker notes" },
    { match: blocks.some((block) => TECH_WORK.test(block)), weight: 1, label: "Tech or engineering work" },
    { match: blocks.some((block) => STUDENT_GROUP.test(block) && SPONSORSHIP.test(block) &&
      !/\b(?:visas?|work permits?|immigration)\b/i.test(block)), weight: 1, label: "Student sponsorship or funding" },
  ].filter(({ match }) => match);
  return { score: signals.reduce((total, signal) => total + signal.weight, 0), reasons: signals.map(({ label }) => label) };
}

function candidateSite(value: string) {
  const site = directorySite(value);
  const domain = monetaryDomainFromWebsite(value);
  if (!site || !domain || NON_ORGANIZATION_HOSTS.some((host) => domainOf(site) === host || site.hostname.endsWith(`.${host}`))) {
    return null;
  }
  return domainOf(site) === domain ? site : new URL(`https://${domain}/`);
}

function targetLocation(location?: string | null) {
  return text(location).slice(0, 150) || METRO_VANCOUVER;
}

async function inspectCompanyWebsite(
  companyName: string, expectedLocation: string, urls: URL[], readPage: typeof readDirectoryPage,
) {
  const site = urls[0];
  const homepage = new URL("/", site);
  const pages = [...new Map([homepage, ...urls].map((url) => [url.href, url])).values()].slice(0, 3);
  const inspect = async (url: URL) => {
    try {
      const page = await readPage(site, url);
      return { url: page.url, ...pageEvidence(page.html, page.url) };
    } catch { return null; }
  };
  const evidence = (await Promise.all(pages.map(inspect))).filter((page) => page !== null);
  const homepageEvidence = evidence.find(({ url }) => url.pathname === "/");
  if (!homepageEvidence?.names.some((name) => name && isSameCompanyName(companyName, name))) return null;
  const visited = new Set(pages.map(({ href }) => href));
  let locationPage = evidence.find(({ locations }) => matchesLocation(locations, expectedLocation));
  if (!locationPage) {
    const contactPages = [...new Map(evidence.flatMap(({ contactLinks }) => contactLinks)
      .filter(({ href }) => !visited.has(href)).map((url) => [url.href, url])).values()].slice(0, 2);
    contactPages.forEach(({ href }) => visited.add(href));
    const checked = (await Promise.all(contactPages.map(inspect))).filter((page) => page !== null);
    evidence.push(...checked);
    locationPage = checked.find(({ locations }) => matchesLocation(locations, expectedLocation));
  }
  if (!locationPage) return null;
  const match: WebsiteMatch = { domain: domainOf(site), location: expectedLocation, evidenceUrl: locationPage.url.href };
  return {
    match,
    async score(notes: string[]) {
      const links = [...new Map(evidence.flatMap(({ fitLinks }) => fitLinks)
        .filter(({ href }) => !visited.has(href)).map((url) => [url.href, url])).values()];
      const pages = [links.find((url) => /communit|scholarship|sponsor|education|outreach/i.test(url.pathname)),
        links.find((url) => !/communit|scholarship|sponsor|education|outreach/i.test(url.pathname))]
        .filter((url) => url !== undefined);
      const fitPages = (await Promise.all(pages.map(inspect))).filter((page) => page !== null);
      const blocks = [...evidence, ...fitPages].flatMap((page) => page.blocks);
      const { score, reasons } = fitScore(match.domain, blocks, notes, companyName);
      const locationEvidence = locationPage.locations.split("\n")
        .find((part) => matchesLocation(part, expectedLocation))?.slice(0, 200);
      return { score, match: { ...match, locationEvidence, reasons } };
    },
  };
}

export async function verifyMonetaryWebsite(
  companyName: string, location: string | null | undefined, selection: unknown, readPage = readDirectoryPage,
) {
  const { domain, evidenceUrl } = record(selection);
  if (typeof evidenceUrl !== "string" || !evidenceUrl.startsWith("https://") || evidenceUrl.length > 1500) return null;
  const site = candidateSite(evidenceUrl);
  if (!site || domainOf(site) !== domain) return null;
  site.search = "";
  site.hash = "";
  return (await inspectCompanyWebsite(companyName, targetLocation(location), [site], readPage))?.match ?? null;
}

export async function resolveExaCompanyDomain(
  { companyName, location, notes = [], key }: {
    companyName: string; location?: string | null; notes?: readonly (string | null | undefined)[]; key?: string;
  },
  { request = fetch, readPage = readDirectoryPage }: { request?: typeof fetch; readPage?: typeof readDirectoryPage } = {},
): Promise<ExaDomainResult> {
  if (!key) return { domain: "", reason: "disabled" };
  const expectedLocation = targetLocation(location);
  let results: unknown;
  try {
    const response = await request("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        query: `Official company website and office contact address for ${companyName} in British Columbia, Canada. Target location: ${expectedLocation}`,
        type: "lite", numResults: 5, excludeDomains: NON_ORGANIZATION_HOSTS,
      }),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { domain: "", reason: "unavailable" };
    results = record(await response.json()).results;
  } catch {
    return { domain: "", reason: "unavailable" };
  }
  if (!Array.isArray(results)) return { domain: "", reason: "unavailable" };

  const candidates = new Map<string, URL[]>();
  for (const item of results.slice(0, 5)) {
    const site = candidateSite(text(record(item).url));
    if (!site) continue;
    site.search = "";
    site.hash = "";
    const domain = domainOf(site);
    const pages = candidates.get(domain) ?? [];
    if (!pages.some((page) => page.href === site.href)) candidates.set(domain, [...pages, site]);
  }

  const checked = await Promise.all([...candidates.values()].map((urls) =>
    inspectCompanyWebsite(companyName, expectedLocation, urls, readPage),
  ));
  const matches = checked.filter((match) => match !== null);
  if (matches.length === 0) return { domain: "", reason: "unconfirmed" };
  if (matches.length === 1) return matches[0].match;
  const trackerNotes = notes.map((note) => text(note).slice(0, 1600));
  const ranked = (await Promise.all(matches.map(({ score }) => score(trackerNotes))))
    .sort((a, b) => b.score - a.score);
  if (ranked[0].score > ranked[1].score) return ranked[0].match;
  return { domain: "", reason: "ambiguous", candidates: ranked.map(({ match }) => match) };
}

type TrackerContext = Pick<Account, "location" | "notes" | "alignmentSummary" | "pitchAngle" | "evidenceUrls">;

export function configuredExaCompanyDomain(companyName: string, account: TrackerContext) {
  const key = process.env.MONETARY_EXA_FALLBACK?.trim().toLowerCase() === "true"
    ? process.env.EXA_API_KEY?.trim() : undefined;
  return resolveExaCompanyDomain({
    companyName, location: account.location, key,
    notes: [account.notes, account.alignmentSummary, account.pitchAngle, account.evidenceUrls],
  });
}

export function websiteNotFoundMessage(failure?: ExaFailure) {
  const hunter = "Hunter could not identify a single company website.";
  const exa = {
    disabled: "",
    unavailable: " Exa could not complete the website search.",
    ambiguous: " Exa found multiple domains and could not pick one with enough evidence.",
    unconfirmed: " Exa could not confirm a website matching the company name and BC location.",
  };
  const candidates = failure?.reason === "ambiguous" ? ` Candidate domains: ${failure.candidates.map(({ domain }) => domain).join(", ")}.` : "";
  return hunter + exa[failure?.reason ?? "disabled"] + candidates + " Add the official website in the tracker.";
}
