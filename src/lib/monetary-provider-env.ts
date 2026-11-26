const PROVIDER_NAMES = {
  apollo: ["APOLLO_API_KEY", "APOLLO_TOKEN"],
  apify: ["APIFY_TOKEN", "APIFY_TPKEN"],
  clay: ["CLAY_PUBLIC_API_KEY", "clay"],
} as const;

/** Resolve only on the server. Never send the value to the browser. */
export function monetaryProviderCredential(
  provider: keyof typeof PROVIDER_NAMES,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const name of PROVIDER_NAMES[provider]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
