import "server-only";

import nodemailer from "nodemailer";

import { MISA_MAILBOX } from "./misa-mailbox";

export class GmailConfigurationError extends Error {}
export class GmailSendError extends Error {
  constructor(
    message: string,
    public readonly failure: "authentication" | "rate_limit" | "upstream",
  ) {
    super(message);
  }
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new GmailConfigurationError(`${name} is not configured on the server.`);
  }
  return value;
}

export function gmailConfiguration() {
  const appPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "") ?? "";
  const configured = Boolean(MISA_MAILBOX) && appPassword.length === 16;
  return { configured, sender: MISA_MAILBOX };
}

function numberProperty(error: unknown, name: "status" | "responseCode") {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[name];
  if (typeof value === "number") return value;
  return null;
}

function codeOf(error: unknown) {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof error.code === "string") return error.code;
  return null;
}

export async function sendGmailMessage({
  to,
  subject,
  body,
}: {
  to: string;
  subject: string;
  body: string;
}) {
  if (!MISA_MAILBOX) throw new GmailConfigurationError("NEXT_PUBLIC_OUTREACH_MAILBOX is not configured.");
  const appPassword = required("GMAIL_APP_PASSWORD").replace(/\s+/g, "");
  if (appPassword.length !== 16) {
    throw new GmailConfigurationError(
      "GMAIL_APP_PASSWORD must be the 16-character Google App Password.",
    );
  }
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: MISA_MAILBOX,
      pass: appPassword,
    },
  });

  try {
    const response = await transporter.sendMail({
      from: MISA_MAILBOX,
      to,
      subject,
      text: body,
    });
    const messageId = response.messageId?.trim();
    if (!messageId) {
      throw new GmailSendError(
        "Gmail accepted the request but returned no message ID.",
        "upstream",
      );
    }
    return { messageId, sender: MISA_MAILBOX };
  } catch (error) {
    if (error instanceof GmailSendError) throw error;
    const status = numberProperty(error, "status");
    const responseCode = numberProperty(error, "responseCode");
    const code = codeOf(error);
    if (
      code === "EAUTH" ||
      status === 401 ||
      status === 403 ||
      responseCode === 534 ||
      responseCode === 535
    ) {
      throw new GmailSendError(
        "Gmail rejected the App Password. Confirm 2-Step Verification is enabled and replace GMAIL_APP_PASSWORD.",
        "authentication",
      );
    }
    if (
      status === 429 ||
      responseCode === 421 ||
      responseCode === 450 ||
      responseCode === 451 ||
      responseCode === 452
    ) {
      throw new GmailSendError(
        "Gmail temporarily blocked sending because a rate or daily limit was reached.",
        "rate_limit",
      );
    }
    throw new GmailSendError(
      "Gmail could not send the message.",
      "upstream",
    );
  }
}
