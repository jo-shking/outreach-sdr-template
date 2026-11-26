import { columnLetter } from "./in-kind.ts";
import { buildContactRow, CONTACTS_HEADERS, CONTACTS_TAB, type ContactRow } from "./sheet-writes.ts";

const MESSAGE_ID_HEADER = "Gmail Message ID";
const emailSentStatus = "Email sent";
export type MonetaryTrackerContact = Pick<ContactRow, "contactId" | "companyId" | "companyName" |
  "name" | "title" | "workEmail" | "linkedinUrl" | "isAlum">;

function cell(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function findMonetaryTrackerContact(rows: readonly unknown[][], contact: MonetaryTrackerContact) {
  const [header = [], ...data] = rows;
  if (!CONTACTS_HEADERS.every((label, index) => cell(header[index]) === cell(label))) {
    throw new Error("The Contacts tab headers do not match the Monetary tracker layout.");
  }

  const messageColumns = header.flatMap((value, index) => cell(value) === cell(MESSAGE_ID_HEADER) ? [index] : []);
  if (messageColumns.length > 1) throw new Error("The Contacts tab has duplicate Gmail Message ID columns.");
  const messageColumn = messageColumns[0] ?? rows.reduce((width, row) => Math.max(width, row.length), 0);
  const email = cell(contact.workEmail);
  const matches = data.flatMap((row, index) => {
    const sameCompany = cell(row[1]) === cell(contact.companyId) ||
      cell(row[2]) === cell(contact.companyName);
    const sameId = cell(row[0]) === cell(contact.contactId);
    return sameCompany && (sameId || cell(row[5]) === email) ? [{ row, number: index + 2 }] : [];
  });
  if (matches.length > 1) throw new Error("Multiple Contacts rows match this recipient. Resolve the duplicate before recording outreach.");
  const existing = matches[0];
  if (existing && cell(existing.row[5]) && cell(existing.row[5]) !== email) {
    throw new Error("The existing Contacts row has a different email address.");
  }
  const alreadyContacted = data.some((row) => (row === existing?.row || cell(row[5]) === email) &&
    (cell(row[messageColumn]) || cell(row[8]) === cell(emailSentStatus) ||
      (cell(row[9]) === "email" && cell(row[11]))));

  return { messageColumn, hasMessageColumn: messageColumns.length === 1, existing, alreadyContacted };
}

export function planMonetaryTrackerWrite(
  rows: readonly unknown[][],
  contact: MonetaryTrackerContact,
  send: { senderName: string; date: string; messageId: string },
) {
  const { messageColumn, hasMessageColumn, existing, alreadyContacted } = findMonetaryTrackerContact(rows, contact);
  const columnLayout = { messageColumn, hasMessageColumn };
  if (alreadyContacted) {
    return { ...columnLayout, recorded: existing?.row[messageColumn] === send.messageId, updates: [], append: null };
  }

  const column = columnLetter(messageColumn);
  const updates = hasMessageColumn ? [] : [{ range: `${CONTACTS_TAB}!${column}1`, values: [[MESSAGE_ID_HEADER]] }];
  if (existing) {
    const { number, row } = existing;
    const currentStatus = cell(row[8]);
    const status = !currentStatus || currentStatus === "not started" || currentStatus === "linkedin sent"
      ? emailSentStatus : String(row[8]);
    if (!cell(row[5])) updates.push({ range: `${CONTACTS_TAB}!F${number}`, values: [[contact.workEmail]] });
    updates.push(
      { range: `${CONTACTS_TAB}!I${number}:L${number}`, values: [[status, "Email", send.senderName, send.date]] },
      { range: `${CONTACTS_TAB}!${column}${number}`, values: [[send.messageId]] },
    );
    return { ...columnLayout, recorded: false, updates, append: null };
  }

  const append = buildContactRow({
    ...contact, outreachStatus: emailSentStatus, channel: "Email", reachedOutBy: send.senderName,
    dateReachedOut: send.date, dateFollowedUp: "",
  });
  while (append.length < messageColumn) append.push("");
  append.push(send.messageId);
  return { ...columnLayout, recorded: false, updates, append };
}
