export const IN_KIND_GOAL = 10_000;

export type InKindSponsor = {
  company: string;
  entries: number;
  valuedEntries: number;
  value: number;
};

function valueInCents(value: unknown): number | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
    value = Number(text.replace(/[$,]/g, ""));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function summarizeInKindInventory(rows: ReadonlyArray<readonly unknown[]>) {
  const [header, ...items] = rows;
  if (header?.[0] !== "ITEM" || header[1] !== "COMPANY" || header[3] !== "VALUE $") {
    throw new Error("In-kind inventory headers changed.");
  }

  let totalCents = 0;
  let unpriced = 0;
  const sponsors = new Map<string, Omit<InKindSponsor, "value"> & { cents: number }>();
  for (const row of items) {
    if (typeof row[0] !== "string" || !row[0].trim() ||
        typeof row[1] !== "string" || !row[1].trim()) continue;
    const cents = valueInCents(row[3]);
    const company = row[1].trim().replace(/\s+/g, " ");
    const key = company.toLowerCase();
    const sponsor = sponsors.get(key) ?? { company, entries: 0, valuedEntries: 0, cents: 0 };
    sponsor.entries++;
    if (cents === null) unpriced++;
    else {
      totalCents += cents;
      sponsor.cents += cents;
      sponsor.valuedEntries++;
    }
    sponsors.set(key, sponsor);
  }
  return {
    total: totalCents / 100,
    unpriced,
    sponsors: Array.from(sponsors.values(), ({ cents, ...sponsor }) => ({
      ...sponsor,
      value: cents / 100,
    })).sort((a, b) => a.company.localeCompare(b.company, "en-CA")),
  };
}
