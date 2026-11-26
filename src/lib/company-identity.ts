const LEGAL_SUFFIXES = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "ltd",
  "plc",
]);

function normalizedName(value: string) {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1) ?? "")) {
    tokens.pop();
  }

  return tokens.join("");
}

function companyNameCandidates(value: string) {
  const candidates = [value];
  const parentheticalAliases = value.matchAll(/\(([^)]+)\)/g);

  for (const match of parentheticalAliases) {
    if (match[1]) candidates.push(match[1]);
  }

  const withoutParentheticals = value.replace(/\([^)]+\)/g, " ");
  candidates.push(withoutParentheticals);

  return new Set(candidates.map(normalizedName).filter(Boolean));
}

export function isSameCompanyName(expected: string, actual: string) {
  const expectedNames = companyNameCandidates(expected);
  const actualNames = companyNameCandidates(actual);

  return [...expectedNames].some((name) => actualNames.has(name));
}
