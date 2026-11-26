// Builds the fallback Gmail compose link used when direct SMTP sending is unavailable.
// A human still reviews the draft before either send path can run.

/** Practical ceiling for a URL a browser will follow. Long bodies exceed it. */
const MAX_URL_LENGTH = 8_000;

export type ComposeLink = {
  url: string;
  /** True when the body was too long to prefill and must be pasted instead. */
  bodyOmitted: boolean;
};

/**
 * `authuser` pins the compose window to the MISA mailbox rather than whichever Google
 * account the browser happens to have in slot 0 — the difference between sending as the
 * club and sending as whoever is signed in.
 */
export function buildGmailComposeLink({
  sendAs,
  to,
  subject,
  body,
}: {
  sendAs: string;
  to: string | null;
  subject: string;
  body: string;
}): ComposeLink {
  const base = "https://mail.google.com/mail/";

  const build = (includeBody: boolean) => {
    const params = new URLSearchParams();
    if (sendAs) params.set("authuser", sendAs);
    params.set("view", "cm");
    params.set("fs", "1");
    if (to) params.set("to", to);
    if (subject) params.set("su", subject);
    if (includeBody && body) params.set("body", body);
    return `${base}?${params.toString()}`;
  };

  const withBody = build(true);

  if (withBody.length <= MAX_URL_LENGTH) {
    return { url: withBody, bodyOmitted: false };
  }

  // Recipient and subject still prefill; the body gets pasted from the Copy button.
  return { url: build(false), bodyOmitted: true };
}
