export const ACCESS_SESSION_COOKIE = "misa-access-v2";

const SESSION_MESSAGE = "misa-access-session-v2";

/** Creates a browser-safe session proof without storing the access code itself. */
export async function accessSessionProof(accessCode: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(accessCode),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(SESSION_MESSAGE),
  );

  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
