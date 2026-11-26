// Client-side glue for the sheet write-back and the recorded-contacts read. Kept out of
// accounts-panel.tsx so the save wiring stays small and the shapes are shared with the
// Already-done view. google-sheets.ts is server-only, so the RecordedContact shape is
// mirrored here rather than imported.

import { canonicalProfile } from "@/lib/contact-merge";
import { MISA_MAILBOX } from "@/lib/misa-mailbox";

/** The club mailbox drafts are sent from. Pins Gmail compose to the MISA account. */
export { MISA_MAILBOX };

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; detail: string }
  | { status: "error"; message: string };

export type RecordedContact = {
  contactId: string;
  companyId: string;
  companyName: string;
  name: string;
  title: string;
  workEmail: string;
  linkedinUrl: string;
  isAlum: boolean;
  outreachStatus: string;
  channel: string;
  reachedOutBy: string;
  dateReachedOut: string;
  dateFollowedUp: string;
};

export type ContactSavePayload = {
  companyName: string;
  companyId: string | null;
  contact: {
    name: string;
    title: string;
    workEmail: string | null;
    linkedinUrl: string | null;
    isAlum: boolean;
  };
  outreachStatus: "Not started" | "Email sent" | "LinkedIn sent";
  channel: "" | "Email" | "LinkedIn";
  reachedOutBy: string;
};

export type ResearchSavePayload = {
  companyName: string;
  companyId: string | null;
  /** Domain inferred from research sources; fills a blank Website cell only. */
  inferredWebsite: string | null;
  research: {
    alignmentSummary: string | null;
    companyOverview: string | null;
    fitScore: number;
    confidenceScore: number;
  };
};

async function postSave(body: Record<string, unknown>): Promise<string> {
  const response = await fetch("/api/save-to-sheet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as {
    saved?: string;
    mode?: string;
    rowNumber?: number;
    error?: string;
  };

  if (!response.ok || !data.saved) {
    throw new Error(data.error ?? "The save failed.");
  }

  if (data.saved === "research") {
    return `Saved to Companies row ${data.rowNumber}.`;
  }

  return data.mode === "updated"
    ? `Updated Contacts row ${data.rowNumber}.`
    : "Added to the Contacts tab.";
}

export function saveResearchToSheet(payload: ResearchSavePayload) {
  return postSave({ action: "research", ...payload });
}

export function saveContactToSheet(payload: ContactSavePayload) {
  return postSave({ action: "contact", ...payload });
}

export async function fetchRecordedContacts(
  companyName: string,
): Promise<RecordedContact[]> {
  const response = await fetch(
    `/api/recorded-contacts?companyName=${encodeURIComponent(companyName)}`,
    { cache: "no-store" },
  );
  const data = (await response.json()) as {
    contacts?: RecordedContact[];
    error?: string;
  };

  if (!response.ok || !Array.isArray(data.contacts)) {
    throw new Error(data.error ?? "Recorded contacts could not be read.");
  }

  return data.contacts;
}

/**
 * Matches a contact shown in the UI against what the sheet already records, so a
 * teammate sees "already contacted" instead of approaching the same person twice.
 * The LinkedIn handle is the stable key; the name is the fallback for rows saved
 * without a profile URL.
 */
export function findRecordedMatch(
  recorded: readonly RecordedContact[],
  contact: { linkedinUrl: string | null; name: string | null },
): RecordedContact | null {
  const profile = contact.linkedinUrl ? canonicalProfile(contact.linkedinUrl) : null;
  if (profile) {
    const byProfile = recorded.find(
      (row) => row.linkedinUrl && canonicalProfile(row.linkedinUrl) === profile,
    );
    if (byProfile) return byProfile;
  }

  const wanted = contact.name?.trim().toLowerCase();
  if (!wanted) return null;
  return (
    recorded.find((row) => row.name.trim().toLowerCase() === wanted) ?? null
  );
}

/** True once outreach has actually happened, as opposed to a row merely saved. */
export function wasContacted(record: RecordedContact) {
  return record.outreachStatus !== "" && record.outreachStatus !== "Not started";
}
