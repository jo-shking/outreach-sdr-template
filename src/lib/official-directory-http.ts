import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { BlockList } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix);

const resolver = new Resolver({ timeout: 2_000, tries: 1 });
const MAX_HTML_BYTES = 1_000_000;

export function directorySite(website: string | null) {
  if (!website) return null;
  try {
    const url = new URL(website.includes("://") ? website : `https://${website}`);
    if (url.protocol === "http:" && !url.port) url.protocol = "https:";
    return isDirectoryUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function isDirectoryUrl(url: URL) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname);
}

export function isSameDirectorySite(url: URL, site: URL) {
  return isDirectoryUrl(url) &&
    url.hostname.replace(/^www\./, "") === site.hostname.replace(/^www\./, "");
}

export async function readDirectoryPage(site: URL, start = site) {
  let url = start;
  for (let redirects = 0; redirects <= 2; redirects++) {
    if (!isSameDirectorySite(url, site)) throw new Error("Directory left its official site.");
    const addresses = await resolver.resolve4(url.hostname);
    if (!addresses.length || addresses.some((address) => blocked.check(address))) {
      throw new Error("Directory host is not public.");
    }
    // Pin the connection to the checked address while keeping the site's TLS identity.
    const page = await new Promise<{ html: string } | { redirect: string }>((resolve, reject) => {
      const req = request(url, {
        agent: false,
        family: 4,
        lookup: (_hostname, _options, callback) => callback(null, addresses[0], 4),
        headers: { Accept: "text/html", "Accept-Encoding": "identity", "User-Agent": "MISA directory reader/1.0" },
        signal: AbortSignal.timeout(5_000),
      }, (res) => {
        res.on("error", reject);
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.destroy();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (status !== 200 || !/^text\/html\b/i.test(res.headers["content-type"] ?? "") ||
            (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
          res.destroy();
          reject(new Error("Directory HTML is unavailable."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_HTML_BYTES) {
            res.destroy(new Error("Directory HTML exceeds the size limit."));
          } else chunks.push(chunk);
        });
        res.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    if ("html" in page) return { html: page.html, url };
    url = new URL(page.redirect, url);
  }
  throw new Error("Directory redirected too many times.");
}
