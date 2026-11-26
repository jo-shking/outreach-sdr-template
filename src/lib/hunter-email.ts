function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function hunterFreeAllowance(account: unknown) {
  const data = record(account);
  const credits = record(record(data.requests).credits);
  return typeof data.plan_name === "string" && data.plan_name.trim().toLowerCase() === "free" &&
    typeof credits.available === "number" && credits.available <= 50 &&
    typeof credits.remaining === "number" && credits.remaining >= 1 &&
    credits.remaining <= credits.available;
}

export function verifiedHunterEmail(result: unknown, domain: string) {
  const data = record(result);
  return record(data.verification).status === "valid" ? workEmailOnDomain(data.email, domain) : null;
}

export function workEmailOnDomain(value: unknown, domain: string) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 320 || /[*•]/.test(email) ||
      !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) return null;
  return email.split("@")[1] === domain ? email : null;
}
