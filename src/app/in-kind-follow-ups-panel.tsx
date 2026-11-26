"use client";

import { useEffect, useState } from "react";
import { buildGmailComposeLink } from "@/lib/gmail-compose";
import { createInKindFollowUpDraft, type FollowUpDraft, type FollowUpQueue } from "@/lib/in-kind-follow-ups";
import { MISA_MAILBOX } from "@/lib/misa-mailbox";

type State = { kind: "loading" | "error" } | { kind: "loaded"; queues: FollowUpQueue[] };
type Review =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; company: string; draft: FollowUpDraft; approved: boolean;
      source?: { rowNumber: number; reviewId: string }; demo?: boolean };

export function InKindFollowUpsPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [owner, setOwner] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<Review>({ kind: "idle" });
  const [copyStatus, setCopyStatus] = useState("");
  const [marking, setMarking] = useState(false);
  const [markStatus, setMarkStatus] = useState("");

  function showDemo() {
    setCopyStatus("");
    setReview({ kind: "ready", company: "Jamie Example",
      draft: createInKindFollowUpDraft("Jamie Example", "christina@example.invalid"),
      approved: false, demo: true });
  }

  async function reviewDraft(rowNumber: number, company: string) {
    setReview({ kind: "loading" });
    setCopyStatus("");
    try {
      const params = new URLSearchParams({ draftFor: String(rowNumber), company });
      const response = await fetch(`/api/follow-ups?${params}`, { cache: "no-store" });
      const { draft, error, reviewId } = (await response.json()) as {
        draft?: FollowUpDraft; error?: string; reviewId?: string;
      };
      if (!response.ok || !draft || !reviewId) throw new Error(error ?? "Could not load a draft.");
      setReview({ kind: "ready", company, draft, approved: false, source: { rowNumber, reviewId } });
    } catch (error) {
      setReview({ kind: "error", message: error instanceof Error ? error.message : "Could not load a draft." });
    }
  }

  function editDraft(field: "subject" | "body", value: string) {
    setCopyStatus("");
    setReview((current) => current.kind === "ready" ? {
      ...current,
      approved: false,
      draft: { ...current.draft, [field]: value },
    } : current);
  }

  async function copyApprovedDraft() {
    if (review.kind !== "ready" || !review.approved || review.demo) return;
    try {
      await navigator.clipboard.writeText(review.draft.body);
      setCopyStatus("Approved draft copied. No email was sent.");
    } catch {
      setCopyStatus("Could not copy. You can select the text and copy it manually.");
    }
  }

  async function markFollowUpSent() {
    if (review.kind !== "ready" || !review.approved || !review.source || review.demo || marking) return;
    if (!window.confirm(`Did you already send this follow-up to ${review.draft.to} from MISA Gmail?`)) return;
    setMarking(true);
    setMarkStatus("");
    try {
      const response = await fetch("/api/follow-ups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...review.source, company: review.company, confirmed: true }),
      });
      const { saved, error } = (await response.json()) as { saved?: boolean; error?: string };
      if (!response.ok || !saved) throw new Error(error ?? "Could not update Sheets.");
      setReview({ kind: "idle" });
      setState({ kind: "loading" });
      setRefresh((value) => value + 1);
      setMarkStatus("Follow-up marked sent in Sheets. It will no longer appear in the queue.");
    } catch (error) {
      setMarkStatus(error instanceof Error ? error.message : "Could not update Sheets.");
    } finally {
      setMarking(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/follow-ups", {
          cache: "no-store", signal: controller.signal,
        });
        const data = (await response.json()) as { queues?: FollowUpQueue[] };
        if (!response.ok || !Array.isArray(data.queues)) throw new Error();
        if (!controller.signal.aborted) setState({ kind: "loaded", queues: data.queues });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "error" });
      }
    }
    void load();
    return () => controller.abort();
  }, [refresh]);

  const queues = state.kind === "loaded" ? state.queues : [];
  const visible = owner ? queues.filter((queue) => (queue.owner ?? "unassigned") === owner) : queues;

  const compose = review.kind === "ready" && review.approved && !review.demo
    ? buildGmailComposeLink({ ...review.draft, sendAs: MISA_MAILBOX }) : null;

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">In-kind follow-ups</h2>
          <p className="mt-1 text-sm text-slate-600">
            Due five weekdays after an in-app email. Shows the oldest 10 per coordinator.
            Review and approve here, then send manually in MISA Gmail.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={review.kind === "loading"} onClick={showDemo}
            className="rounded-lg border border-indigo-200 px-3 py-2 text-sm font-medium text-indigo-700">
            Try demo
          </button>
          <button
          type="button"
          onClick={() => { setState({ kind: "loading" }); setRefresh((value) => value + 1); }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium"
        >
            Refresh
          </button>
        </div>
      </div>
      {state.kind === "loading" && <p role="status" className="text-sm">Loading follow-ups…</p>}
      {markStatus && <p role="status" className="text-sm text-slate-700">{markStatus}</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-red-700">Could not load follow-ups. Try refreshing.</p>}
      {review.kind === "loading" && <p role="status" className="text-sm">Preparing draft…</p>}
      {review.kind === "error" && <p role="alert" className="text-sm text-red-700">{review.message}</p>}
      {review.kind === "ready" && (
        <div className="grid gap-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Review draft · {review.company}</h3>
            <button type="button" onClick={() => setReview({ kind: "idle" })} className="text-sm underline">
              Close draft
            </button>
          </div>
          {review.demo && <p role="status" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            Demo only. Jamie Example is a pretend follow-up due today. It is not in the tracker.
          </p>}
          <p className="break-all text-sm">From: {MISA_MAILBOX}</p>
          <p className="break-all text-sm">To ({review.demo ? "test address" : "current tracker address"}): {review.draft.to}</p>
          <label className="grid gap-1 text-sm font-medium">
            Subject
            <input className="rounded-lg border border-slate-300 bg-white p-2" maxLength={300}
              value={review.draft.subject} onChange={(event) => editDraft("subject", event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Message
            <textarea className="rounded-lg border border-slate-300 bg-white p-2" rows={8} maxLength={5000}
              value={review.draft.body} onChange={(event) => editDraft("body", event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button"
              disabled={review.approved || !review.draft.subject.trim() || !review.draft.body.trim()}
              onClick={() => setReview({ ...review, approved: true })}
              className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {review.approved ? "Draft approved" : "Approve draft"}
            </button>
            {compose && (
              <a href={compose.url} target="_blank" rel="noopener noreferrer"
                className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white">
                Open in MISA Gmail
              </a>
            )}
            {review.demo && review.approved && (
              <button type="button" disabled className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-500">
                Gmail disabled in demo
              </button>
            )}
            {compose && (
              <button type="button" onClick={() => void copyApprovedDraft()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium">
                Copy approved message
              </button>
            )}
            {compose && review.source && (
              <button type="button" disabled={marking} onClick={() => void markFollowUpSent()}
                className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-800 disabled:opacity-60">
                {marking ? "Saving…" : "Mark follow-up sent"}
              </button>
            )}
          </div>
          <p className="text-sm text-slate-600">
            {review.demo ? "You can edit and approve this demo, but it cannot send email." :
              "Editing clears approval. Verify the From address before you press Send in Gmail."}
          </p>
          {compose?.bodyOmitted && (
            <p className="text-sm text-amber-800">The message is too long to prefill. Copy it and paste it into Gmail.</p>
          )}
          {copyStatus && <p role="status" className="text-sm text-slate-600">{copyStatus}</p>}
        </div>
      )}
      {state.kind === "loaded" && (
        <>
          <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Coordinator
            <select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white p-2 text-slate-900"
            >
              <option value="">All coordinators</option>
              {queues.map(({ owner, totalDue }) => (
                <option key={owner ?? "unassigned"} value={owner ?? "unassigned"}>
                  {owner ?? "Unassigned"} ({totalDue} due)
                </option>
              ))}
            </select>
          </label>
          {visible.map((queue) => (
            <div key={queue.owner ?? "unassigned"} className="rounded-xl border border-slate-200 p-4">
              <h3 className="font-semibold">{queue.owner ?? "Unassigned"} · {queue.totalDue} due</h3>
              {queue.items.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">Nothing due.</p>
              ) : (
                <>
                  <ul className="mt-2 divide-y divide-slate-100">
                    {queue.items.map((item) => (
                      <li key={item.rowNumber} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                        <span className="font-medium">{item.company}</span>
                        <span className="text-slate-600">Sent {item.sentOn} · Due {item.dueOn}</span>
                        <button type="button" disabled={review.kind === "loading"}
                          onClick={() => void reviewDraft(item.rowNumber, item.company)}
                          className="rounded-md border border-indigo-200 px-2 py-1 font-medium text-indigo-700 disabled:opacity-60">
                          Review draft
                        </button>
                      </li>
                    ))}
                  </ul>
                  {queue.totalDue > queue.items.length && (
                    <p className="mt-2 text-sm text-slate-600">Showing {queue.items.length} of {queue.totalDue} due.</p>
                  )}
                </>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
