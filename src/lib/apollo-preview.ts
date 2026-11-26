// Apollo's people search returns deliberately incomplete records: the last name is
// masked and the email and LinkedIn URL are withheld until a credit is spent. Titles do
// come through free, so the whole list can be ranked before revealing anyone — which is
// what keeps the cost at one credit per account instead of one per person.
import { isTargetRole, rolePriority } from "./employee-normalize.ts";

export type ApolloPreview = {
  apolloId: string;
  firstName: string;
  maskedName: string;
  title: string;
  organizationName: string | null;
  hasEmail: boolean;
  rolePriority: number;
  isTargetRole: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, maxLength = 300) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null;
}

/**
 * Maps one search result. No employer check happens here: the search is scoped by
 * `q_organization_domains_list`, so Apollo has already constrained results to the
 * account's own domain. Verifying the brand string instead would reject legitimate
 * rebrands — Apollo reports "APPLY" where the sheet says "Apply Digital".
 */
export function normalizeApolloPreview(value: unknown): ApolloPreview | null {
  const item = record(value);
  if (!item) return null;

  const apolloId = stringValue(item.id, 100);
  const firstName = stringValue(item.first_name, 200);
  const title = stringValue(item.title, 300);

  // Without an id the person cannot be revealed later, so the row is useless.
  if (!apolloId || !firstName || !title) return null;

  const masked =
    stringValue(item.last_name_obfuscated, 200) ??
    stringValue(item.last_name, 200);
  const priority = rolePriority(title);

  return {
    apolloId,
    firstName,
    maskedName: masked ? `${firstName} ${masked}` : firstName,
    title,
    organizationName: stringValue(record(item.organization)?.name, 300),
    hasEmail: item.has_email === true,
    rolePriority: priority,
    isTargetRole: isTargetRole(priority),
  };
}

/**
 * Orders previews the same way revealed contacts are ordered: a role MISA named comes
 * first, then whether an email is even available, then the role's own score. SFU status
 * cannot participate — Apollo carries no education, so it is unknown until a reveal
 * produces a LinkedIn URL to cross-reference.
 */
export function rankApolloPreviews(
  previews: readonly ApolloPreview[],
): ApolloPreview[] {
  return [...previews].sort(
    (a, b) =>
      Number(b.isTargetRole) - Number(a.isTargetRole) ||
      Number(b.hasEmail) - Number(a.hasEmail) ||
      b.rolePriority - a.rolePriority ||
      a.maskedName.localeCompare(b.maskedName),
  );
}
