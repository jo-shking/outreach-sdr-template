import { extractEmailAddress, isInKindContacted, type InKindColumns } from "./in-kind.ts";

const DAY_MS = 86_400_000;
export const FOLLOW_UP_BUSINESS_DAYS = 5;
export const FOLLOW_UP_QUEUE_LIMIT = 10;
export const FOLLOW_UP_SENT_HEADER = "FOLLOW-UP SENT ON";

export function findFollowUpSentColumn(header: readonly string[]) {
  return header.findIndex((cell) => cell.trim().toUpperCase() === FOLLOW_UP_SENT_HEADER);
}

export function vancouverDate(instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function sentDate(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000) {
    return isoDate(new Date(Date.UTC(1899, 11, 30) + value * DAY_MS));
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && isoDate(date) === text ? text : null;
}

export function inKindFollowUpDue(sentOn: string) {
  const day = new Date(`${sentOn}T00:00:00Z`);
  for (let remaining = FOLLOW_UP_BUSINESS_DAYS; remaining > 0;) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) remaining--;
  }
  return isoDate(day);
}

type DueFollowUp = { rowNumber: number; company: string; sentOn: string; dueOn: string };
export type FollowUpQueue = { owner: string | null; totalDue: number; items: DueFollowUp[] };
export type FollowUpDraft = { to: string; subject: string; body: string };

/** Builds a draft only for a currently visible, due follow-up with one recipient. */
export function buildInKindFollowUpDraft(
  queues: readonly FollowUpQueue[],
  rows: ReadonlyArray<readonly unknown[]>,
  columns: InKindColumns,
  rowNumber: number,
  company: string,
): FollowUpDraft | null {
  const item = queues.flatMap((queue) => queue.items).find(
    (candidate) => candidate.rowNumber === rowNumber && candidate.company === company,
  );
  if (!item) return null;
  const to = extractEmailAddress(String(rows[rowNumber - 2]?.[columns.contactInfo] ?? ""));
  if (!to) return null;
  return createInKindFollowUpDraft(item.company, to);
}

export function createInKindFollowUpDraft(company: string, to: string): FollowUpDraft {
  return {
    to,
    subject: "Follow-up: Example Student Association in-kind sponsorship request",
    body: `Hello ${company} team,\n\nI’m following up on Example Student Association’s in-kind sponsorship request. Would your team be open to contributing an item, gift card, or voucher for an upcoming student event?\n\nI’d be happy to share more details. Thank you for considering our request.\n\nBest,\nExample Student Association Corporate Relations`,
  };
}

export function buildInKindFollowUpQueues(
  rows: ReadonlyArray<readonly unknown[]>,
  columns: InKindColumns,
  teamNames: readonly string[],
  today: string,
  completedColumn = -1,
): FollowUpQueue[] {
  const queues: FollowUpQueue[] = teamNames.map((owner) => ({ owner, totalDue: 0, items: [] }));
  const unassigned: FollowUpQueue = { owner: null, totalDue: 0, items: [] };
  if (columns.gmailMessageId === null) return queues;
  const messageColumn = columns.gmailMessageId;
  const completed = new Set(completedColumn < 0 ? [] : rows.flatMap((row) =>
    String(row[completedColumn] ?? "").trim() ? [String(row[messageColumn] ?? "").trim()] : [],
  ));
  const byOwner = new Map(queues.map((queue) => [queue.owner?.toLowerCase(), queue]));
  const due = rows.flatMap((row, index) => {
    const company = String(row[columns.company] ?? "").trim();
    const messageId = String(row[messageColumn] ?? "").trim();
    const status = String(row[columns.status] ?? "");
    const sentOn = sentDate(row[columns.dateOfReq]);
    if (!company || !messageId || completed.has(messageId) || !sentOn || !isInKindContacted(status)) return [];
    const dueOn = inKindFollowUpDue(sentOn);
    if (dueOn > today) return [];
    const owner = columns.contactedBy === null ? "" : String(row[columns.contactedBy] ?? "");
    return [{ rowNumber: index + 2, company, sentOn, dueOn, owner, messageId }];
  }).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.rowNumber - b.rowNumber);

  const seen = new Set<string>();
  for (const { owner, messageId, ...item } of due) {
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    const queue = byOwner.get(owner.trim().toLowerCase()) ?? unassigned;
    queue.totalDue++;
    if (queue.items.length < FOLLOW_UP_QUEUE_LIMIT) queue.items.push(item);
  }
  return unassigned.totalDue > 0 ? [...queues, unassigned] : queues;
}
