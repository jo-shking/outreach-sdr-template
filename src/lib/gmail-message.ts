export type GmailMessageInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

function safeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Builds the RFC 2822 message format required by Gmail's messages.send API. */
export function buildRawGmailMessage(input: GmailMessageInput) {
  const subject = Buffer.from(safeHeader(input.subject), "utf8").toString(
    "base64",
  );
  const mime = [
    `From: ${safeHeader(input.from)}`,
    `To: ${safeHeader(input.to)}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ].join("\r\n");

  return Buffer.from(mime, "utf8").toString("base64url");
}
