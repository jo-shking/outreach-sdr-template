import { load } from "cheerio";

type DirectoryPerson = { name: string; title: string };

function clean(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function readDirectoryPeople(html: string, { chang = false, directoryPage = false } = {}) {
  const $ = load(html);
  const people = new Map<string, DirectoryPerson>();
  function add(rawName: unknown, rawTitle: unknown) {
    const name = clean(rawName);
    const title = clean(rawTitle);
    if (name.length > 100 || title.length > 160 || !title ||
        !/^[\p{L}\p{M}][\p{L}\p{M}.'’\-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}.'’\-]*){1,6}$/u.test(name)) return;
    const key = name.toLowerCase();
    if (!people.has(key)) people.set(key, { name, title });
  }

  if (chang) {
    $("main .toggle > p").each((_, element) => {
      const parts = clean($(element).text()).match(/^(.+?)\s+[–—-]\s+(.+)$/);
      if (parts && /\b(?:incubat\w*|executive director|partnerships?|communications?)\b/i.test(parts[2])) {
        add(parts[1], parts[2]);
      }
    });
    return [...people.values()];
  }

  function visit(value: unknown, listedEmployee = false) {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, listedEmployee);
    } else if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if ((listedEmployee || directoryPage) && types.some((type) =>
        typeof type === "string" && /(?:^|\/)Person$/.test(type),
      )) add(item.name, item.jobTitle);
      visit(item["@graph"], listedEmployee);
      visit(item.employee, true);
      visit(item.employees, true);
    }
  }
  $('script[type="application/ld+json"]').each((_, element) => {
    try { visit(JSON.parse($(element).text())); } catch { /* Ignore invalid structured data. */ }
  });
  $('[itemscope][itemtype$="/Person"]').each((_, element) => {
    const person = $(element);
    add(person.find('[itemprop="name"]').first().text(), person.find('[itemprop="jobTitle"]').first().text());
  });
  if (directoryPage) {
    $(".team-member, .staff-member, .leadership-card, .person-card, .employee-card").each((_, element) => {
      const card = $(element);
      add(
        card.find(".name, .team-member-name, .staff-name, h2, h3, h4").first().text(),
        card.find(".job-title, .position, .role, .team-member-title, .staff-title").first().text(),
      );
    });
  }
  return [...people.values()];
}

export function directoryLinks(html: string, page: URL) {
  const $ = load(html);
  const links = new Map<string, { url: URL; rank: number }>();
  $("a[href]").each((_, element) => {
    if (links.size >= 40) return false;
    try {
      const url = new URL($(element).attr("href") ?? "", page);
      const path = url.pathname.toLowerCase();
      const label = clean($(element).text()).toLowerCase();
      const team = /^(?:our team|the team|meet (?:the|our) team|leadership|staff directory|our people|people|team)$/.test(label) ||
        isDirectoryPagePath(path);
      const about = /(?:^|\/)(?:about|about-us)(?:[/.]|$)/.test(path);
      if ((team || about) && url.origin === page.origin && path !== page.pathname.toLowerCase() &&
          !/\.(?:pdf|zip|jpg|png|svg|docx?)$/.test(path)) {
        url.hash = "";
        url.search = "";
        links.set(url.href, { url, rank: team ? 1 : 0 });
      }
    } catch { /* Ignore malformed links. */ }
  });
  return [...links.values()].sort((a, b) => b.rank - a.rank).slice(0, 3);
}

export function isDirectoryPagePath(path: string) {
  return /(?:^|\/)(?:team|our-team|leadership|leadership-team|people|our-people|staff|staff-directory)(?:[/.]|$)/i.test(path);
}
