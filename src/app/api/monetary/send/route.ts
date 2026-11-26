import "server-only";

import { GmailConfigurationError, GmailSendError, sendGmailMessage } from "@/lib/gmail-send";
import { getAccounts, prepareMonetaryTrackerSend } from "@/lib/google-sheets";
import { extractEmailAddress } from "@/lib/in-kind";
import { vancouverDate } from "@/lib/in-kind-follow-ups";
import { companyIdFor, contactIdFor, TEAM_NAMES } from "@/lib/sheet-writes";

const sending = new Set<string>();

function field(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= maxLength ? text : "";
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    (fetchSite && fetchSite !== "same-origin") ||
    (origin && (!host || (origin !== `https://${host}` && origin !== `http://${host}`)))
  ) {
    return Response.json({ error: "Send from the Monetary tab." }, { status: 403 });
  }

  const body: unknown = await request.json().catch(() => null);
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  const to = field(input.to, 320).toLowerCase();
  const subject = field(input.subject, 300);
  const message = field(input.body, 5_000);
  const senderName = field(input.senderName, 200);
  const companyName = field(input.companyName, 200);
  const suppliedCompanyId = field(input.companyId, 200);
  const contact = input.contact && typeof input.contact === "object" && !Array.isArray(input.contact)
    ? input.contact as Record<string, unknown> : {};
  const contactName = field(contact.name, 200);
  const linkedinUrl = field(contact.linkedinUrl, 500);
  if (
    input.confirmed !== true || extractEmailAddress(to) !== to ||
    !subject || /[\r\n]/.test(subject) || !message || !companyName || !contactName ||
    !(TEAM_NAMES as readonly string[]).includes(senderName)
  ) {
    return Response.json(
      { error: "A valid account, contact, subject, message, team sender, and final confirmation are required." },
      { status: 400 },
    );
  }

  if (sending.has(to)) {
    return Response.json({ error: "A send is already in progress for this recipient." }, { status: 409 });
  }
  sending.add(to);
  try {
    let tracker;
    try {
      const accounts = (await getAccounts()).filter((account) => account.companyName === companyName &&
        (!suppliedCompanyId || account.companyId === suppliedCompanyId));
      if (accounts.length !== 1) {
        return Response.json({ error: "The company is missing or ambiguous in the tracker. Refresh Monetary.", notSent: true }, { status: 409 });
      }
      const companyId = accounts[0].companyId || companyIdFor(companyName);
      const contactId = contactIdFor(companyId, linkedinUrl || null, contactName);
      if (!companyId || !contactId) {
        return Response.json({ error: "The company or contact is missing a tracker ID.", notSent: true }, { status: 400 });
      }
      tracker = await prepareMonetaryTrackerSend({
        companyId, contactId, companyName, name: contactName, workEmail: to, linkedinUrl,
        title: field(contact.title, 300), isAlum: contact.sfuAlumni === true,
      });
    } catch {
      return Response.json({ error: "The app could not verify the Contacts tab or locate a unique contact row. Check the Monetary tracker before sending.", notSent: true }, { status: 502 });
    }
    if (tracker.alreadyContacted) {
      return Response.json({ error: "This email is already marked contacted in the Monetary tracker.", notSent: true }, { status: 409 });
    }

    const sent = await sendGmailMessage({ to, subject, body: message });
    const headers = { "Cache-Control": "no-store" };
    try {
      await tracker.record({ senderName, date: vancouverDate(), messageId: sent.messageId });
      return Response.json({ sent: true, recorded: true, ...sent }, { headers });
    } catch {
      return Response.json({
        sent: true, recorded: false, ...sent,
        warning: "Gmail sent the email, but the Monetary tracker could not record it. Do not send it again.",
      }, { headers });
    }
  } catch (error) {
    if (error instanceof GmailConfigurationError) {
      return Response.json({ error: error.message, notSent: true }, { status: 503 });
    }
    if (error instanceof GmailSendError && error.failure !== "upstream") {
      return Response.json(
        { error: error.message, notSent: true },
        { status: error.failure === "rate_limit" ? 429 : 502 },
      );
    }
    return Response.json(
      { error: "Gmail did not confirm the send. Check the Gmail Sent folder before trying again." },
      { status: 502 },
    );
  } finally {
    sending.delete(to);
  }
}
