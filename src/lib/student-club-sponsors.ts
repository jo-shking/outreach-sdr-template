export const STUDENT_CLUB_SPONSOR_SOURCE_URL = process.env.STUDENT_CLUB_SPONSOR_SOURCE_URL?.trim() || null;

const STUDENT_CLUB_SPONSOR_NAMES = STUDENT_CLUB_SPONSOR_SOURCE_URL
  ? (process.env.STUDENT_CLUB_SPONSOR_NAMES ?? "").split("\n")
  : [];

function normalizeCompanyName(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replaceAll("&", " and ")
    .replace(
      /\b(?:incorporated|corporation|company|limited|ltd|inc|llp|lp|corp|co)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const NORMALIZED_STUDENT_CLUB_SPONSORS = new Set(
  STUDENT_CLUB_SPONSOR_NAMES.map(normalizeCompanyName),
);

export function hasPastStudentClubSponsorship(companyName: string) {
  const normalized = normalizeCompanyName(companyName);
  return normalized.length >= 2 && NORMALIZED_STUDENT_CLUB_SPONSORS.has(normalized);
}
