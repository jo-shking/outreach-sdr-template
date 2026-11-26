export const CHANG_TEAM_SOURCE = process.env.MONETARY_SHARED_DIRECTORY_URL?.trim() || "";

export function isChangInstituteAccount(companyName: string | null | undefined) {
  const configured = process.env.MONETARY_SHARED_DIRECTORY_COMPANY?.trim().toLowerCase();
  return Boolean(CHANG_TEAM_SOURCE && configured && companyName?.trim().toLowerCase() === configured);
}

export function isMonetaryTargetRole(title: string) {
  return /\b(?:recruit\w*|talent acquisition|early careers?|communications?|community|social impact|social purpose|corporate social responsibility|csr|partnerships?)\b/i.test(title);
}
