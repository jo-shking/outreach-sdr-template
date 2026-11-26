"use client";

import { useRef, useState } from "react";

import type { CompanyResearch } from "@/lib/company-research";
import { DEFAULT_MISA_EVENTS, DEFAULT_PARTNERSHIP_FORMATS } from "@/lib/misa-outreach-context";
import { MISA_MAILBOX } from "@/lib/misa-mailbox";
import { getMonetaryHistory, setMonetarySendStatus } from "@/lib/monetary-browser-history";
import { hasPersonalizationEvidence } from "@/lib/outreach-content";
import type { OutreachDraft } from "@/lib/outreach-draft";
import { TEAM_MEMBERS } from "@/lib/sheet-writes";
import type { VerifiedMonetaryContact } from "@/lib/monetary-waterfall";

export type MonetaryDraftTarget = {
  companyId: string | null;
  companyName: string;
  website: string | null;
  contact: VerifiedMonetaryContact;
};

type DraftState =
  | { status: "idle" }
  | { status: "researching" | "drafting" }
  | { status: "error"; message: string }
  | { status: "ready"; draft: OutreachDraft; sources: CompanyResearch["sources"] };

const context = {
  misaEvents: DEFAULT_MISA_EVENTS,
  partnershipFormats: DEFAULT_PARTNERSHIP_FORMATS,
};

async function post<T extends { error?: string }>(endpoint: string, body: object, failure: string) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as T | null;
  if (!response.ok || !data) throw new Error(data?.error ?? failure);
  return data;
}

export function MonetaryDraft({
  target, researchFor, sendStatus,
}: {
  target: MonetaryDraftTarget;
  researchFor: (target: MonetaryDraftTarget) => Promise<CompanyResearch>;
  sendStatus?: "pending" | "sent";
}) {
  const [senderName, setSenderName] = useState<string>(TEAM_MEMBERS[0].name);
  const [state, setState] = useState<DraftState>({ status: "idle" });
  const [approved, setApproved] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [recorded, setRecorded] = useState(false);
  const [recordingWarning, setRecordingWarning] = useState("");
  const pending = useRef(false);
  const sendPending = useRef(false);
  const busy = state.status === "researching" || state.status === "drafting";
  const { companyName, contact } = target;
  const email = contact.workEmail.toLowerCase();
  const readOnly = sending || Boolean(sendStatus);
  const validDraft = state.status === "ready" && Boolean(state.draft.subject.trim() && state.draft.body.trim());

  async function generate() {
    if (pending.current) return;
    pending.current = true;
    setState({ status: "researching" });

    try {
      const research = await researchFor(target);

      setState({ status: "drafting" });
      const data = await post<{ draft?: OutreachDraft; error?: string }>(
        "/api/monetary/draft",
        {
          companyName,
          research,
          contact: {
            name: contact.name,
            title: contact.title,
            currentCompany: contact.company,
            currentEmploymentEvidence: contact.sourceUrl ?? contact.linkedinUrl ?? contact.provider,
          },
          sender: TEAM_MEMBERS.find(({ name }) => name === senderName),
          recipientEmail: contact.workEmail,
          ...context,
        },
        "The outreach draft failed.",
      );
      if (!data.draft) throw new Error("The server returned no email draft.");
      const draft = data.draft;
      setState({
        status: "ready",
        draft,
        sources: research.sources.filter(({ id, url }) =>
          draft.whyYouSourceIds.includes(id) && /^https?:\/\//i.test(url),
        ),
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "The outreach draft failed.",
      });
    } finally {
      pending.current = false;
    }
  }

  async function withSendLock(action: () => Promise<void>) {
    if (!navigator.locks) return action();
    await navigator.locks.request(`misa-monetary-send:${email}`, { ifAvailable: true }, async (lock) => {
      if (lock) await action();
      else setSendError("A send is already in progress for this address in another tab.");
    });
  }

  async function sendDraft(draft: OutreachDraft) {
    if (sendPending.current || !approved || !validDraft || sendStatus) return;
    if (!window.confirm(`Send this approved email to ${email} from ${MISA_MAILBOX}?`)) return;
    sendPending.current = true;
    setSending(true);
    setSendError("");
    try {
      await withSendLock(async () => {
        if (getMonetaryHistory().sent?.[email]) return;
        setMonetarySendStatus(email, "pending");
        const response = await fetch("/api/monetary/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: email, subject: draft.subject, body: draft.body, senderName, confirmed: true,
            companyId: target.companyId, companyName,
            contact: {
              name: contact.name, title: contact.title, linkedinUrl: contact.linkedinUrl, sfuAlumni: contact.sfuAlumni,
            },
          }),
        });
        const data = await response.json().catch(() => null) as {
          sent?: boolean; recorded?: boolean; notSent?: boolean; error?: string; warning?: string; messageId?: string;
        } | null;
        if (response.ok && data?.sent === true) {
          setRecorded(data.recorded === true);
          if (data.warning) setRecordingWarning(`${data.warning} Gmail message ID ${data.messageId ?? "unavailable"}`);
          setMonetarySendStatus(email, "sent");
          return;
        }
        if (data?.notSent || [400, 401, 403].includes(response.status)) {
          setMonetarySendStatus(email, null);
        }
        setSendError(data?.error ?? "The app could not confirm the send.");
      });
    } catch {
      setSendError("The app could not confirm the send.");
    } finally {
      sendPending.current = false;
      setSending(false);
    }
  }

  async function clearUnconfirmedSend() {
    if (!window.confirm("Have you checked the Gmail Sent folder and confirmed this email was absent?")) return;
    try {
      await withSendLock(async () => {
        if (getMonetaryHistory().sent?.[email] !== "pending") return;
        setMonetarySendStatus(email, null);
        setApproved(false);
        setSendError("");
      });
    } catch {
      setSendError("The app could not reset the send status.");
    }
  }

  return (
    <div className="grid gap-3">
      <p className="break-words text-slate-700">To {contact.name} · {contact.workEmail}</p>
      <label className="grid gap-1 font-medium">
        Sender
        <select value={senderName} disabled={busy || state.status === "ready"}
          onChange={(event) => setSenderName(event.target.value)}
          className="rounded-lg border border-slate-300 p-2">
          {TEAM_MEMBERS.map(({ name }) => <option key={name}>{name}</option>)}
        </select>
      </label>
      {sendStatus === "sent" && <p role="status" className="text-emerald-800">
        {recorded ? "Email sent and recorded in the Monetary tracker." : `Email sent from ${MISA_MAILBOX}.`}
      </p>}
      {recordingWarning && <p role="alert" className="break-words text-amber-800">{recordingWarning}</p>}
      {sendStatus === "pending" && !sending && <div className="space-y-2">
        <p role="status" className="text-amber-800">Send status unconfirmed. Check the Gmail Sent folder before retrying.</p>
        <button type="button" className="text-indigo-700 underline" onClick={() => void clearUnconfirmedSend()}>
          Reset send status
        </button>
      </div>}
      {sendError && <p role="alert" className="text-red-700">{sendError}</p>}
      {state.status !== "ready" && !sendStatus && <>
        <p className="text-slate-600">Research and drafting can use Exa and OpenRouter credits.</p>
        <button type="button" disabled={busy} onClick={() => void generate()}
          className="w-fit rounded-lg bg-indigo-700 px-3 py-2 font-semibold text-white disabled:opacity-50">
          {state.status === "researching" ? "Researching company…" : state.status === "drafting" ? "Writing draft…" : "Research and draft"}
        </button>
        {busy && <p role="status">{state.status === "researching" ? "Finding company evidence." : "Writing the outreach email."}</p>}
      </>}
      {state.status === "error" && <p role="alert" className="text-red-700">{state.message}</p>}
      {state.status === "ready" && <>
        <label className="grid gap-1 font-medium">
          Subject
          <input value={state.draft.subject} maxLength={300} readOnly={readOnly} onChange={(event) => {
            setApproved(false);
            setState({ ...state, draft: { ...state.draft, subject: event.target.value } });
          }} className="rounded-lg border border-slate-300 p-2 font-normal" />
        </label>
        <label className="grid gap-1 font-medium">
          Email body
          <textarea rows={12} value={state.draft.body} maxLength={5_000} readOnly={readOnly} onChange={(event) => {
            setApproved(false);
            setState({ ...state, draft: { ...state.draft, body: event.target.value } });
          }} className="rounded-lg border border-slate-300 p-2 font-normal" />
        </label>
        {state.sources.length > 0 && <ul aria-label="Sources used in this draft" className="grid gap-1">
          {state.sources.map(({ id, title, url }) =>
            <li key={id}><a href={url} target="_blank" rel="noopener noreferrer"
              className="break-words text-indigo-700 underline">{title || url}</a></li>,
          )}
        </ul>}
        {[...state.draft.violations, ...state.draft.limitations].map((note, index) =>
          <p key={index} className="text-amber-800">{note}</p>,
        )}
        {!sendStatus && <label className="flex w-fit items-center gap-2 font-medium">
          <input type="checkbox" checked={approved} disabled={!validDraft || sending}
            onChange={(event) => setApproved(event.target.checked)} />
          I reviewed and approve this draft
        </label>}
        {(sending || !sendStatus) && <button type="button" onClick={() => void sendDraft(state.draft)}
          disabled={!approved || !validDraft || readOnly}
          className="w-fit rounded-lg bg-emerald-700 px-3 py-2 font-semibold text-white disabled:opacity-50">
          {sending ? "Sending…" : "Send from Gmail"}
        </button>}
      </>}
    </div>
  );
}

export function researchMonetaryCompany(
  { companyId, companyName, website }: MonetaryDraftTarget,
  pendingResearch: Map<string, Promise<CompanyResearch>>,
) {
  const key = JSON.stringify([companyId, companyName, website]);
  const existing = pendingResearch.get(key);
  if (existing) return existing;
  const request = post<{ research?: CompanyResearch; error?: string }>(
    "/api/monetary/research",
    { companyId, companyName, website, ...context },
    "The company research failed.",
  ).then(({ research }) => {
    if (!research) throw new Error("The company research returned no result.");
    if (!hasPersonalizationEvidence(research)) pendingResearch.delete(key);
    return research;
  }).catch((error: unknown) => {
    pendingResearch.delete(key);
    throw error;
  });
  pendingResearch.set(key, request);
  return request;
}
