"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { dueState, type FollowUpRow } from "@/lib/follow-ups";
import { TEAM_MEMBERS } from "@/lib/sheet-writes";

import { type SaveState } from "./sheet-save";

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; followUps: FollowUpRow[]; today: string }
  | { status: "error"; message: string };

const DUE_ORDER = { overdue: 0, today: 1, unknown: 2, upcoming: 3 } as const;

/**
 * Companies the team is waiting to hear back from after a call. Rows live in
 * the tracker's Follow-ups tab; the email reminder on the due date is sent by
 * the Apps Script installed in the tracker, not by this app.
 */
export function FollowUpsPanel({ active }: { active: boolean }) {
  const [state, setState] = useState<ListState>({ status: "idle" });
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [rowStates, setRowStates] = useState<Record<number, SaveState>>({});
  const [company, setCompany] = useState("");
  const [expectedReply, setExpectedReply] = useState("");
  const [note, setNote] = useState("");
  const [addedBy, setAddedBy] = useState<string>(TEAM_MEMBERS[0].name);
  const requestedRef = useRef(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/follow-ups", { cache: "no-store" });
      const data = (await response.json()) as {
        followUps?: FollowUpRow[];
        today?: string;
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.followUps) || !data.today) {
        throw new Error(data.error ?? "The follow-up list could not be loaded.");
      }
      setState({ status: "success", followUps: data.followUps, today: data.today });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The follow-up list could not be loaded.",
      });
    }
  }, []);

  useEffect(() => {
    if (active && !requestedRef.current) {
      requestedRef.current = true;
      void load();
    }
  }, [active, load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (saveState.status === "saving") return;
    setSaveState({ status: "saving" });

    try {
      const response = await fetch("/api/follow-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, expectedReply, note, addedBy }),
      });
      const data = (await response.json()) as { saved?: boolean; error?: string };
      if (!response.ok || !data.saved) {
        throw new Error(data.error ?? "The follow-up could not be saved.");
      }
      setSaveState({ status: "saved", detail: `${company} added.` });
      setCompany("");
      setExpectedReply("");
      setNote("");
      void load();
    } catch (error) {
      setSaveState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The follow-up could not be saved.",
      });
    }
  }

  async function heardBack(row: FollowUpRow) {
    if (rowStates[row.rowNumber]?.status === "saving") return;
    setRowStates((current) => ({
      ...current,
      [row.rowNumber]: { status: "saving" },
    }));

    try {
      const response = await fetch("/api/follow-ups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: row.rowNumber, company: row.company }),
      });
      const data = (await response.json()) as { saved?: boolean; error?: string };
      if (!response.ok || !data.saved) {
        throw new Error(data.error ?? "The update failed.");
      }
      setRowStates((current) => ({
        ...current,
        [row.rowNumber]: { status: "saved", detail: "Marked heard back." },
      }));
      void load();
    } catch (error) {
      setRowStates((current) => ({
        ...current,
        [row.rowNumber]: {
          status: "error",
          message: error instanceof Error ? error.message : "The update failed.",
        },
      }));
    }
  }

  const rows =
    state.status === "success"
      ? [...state.followUps].sort((a, b) => {
          const doneA = a.status === "Heard back" ? 1 : 0;
          const doneB = b.status === "Heard back" ? 1 : 0;
          if (doneA !== doneB) return doneA - doneB;
          const stateA = DUE_ORDER[dueState(a.expectedReply, state.today)];
          const stateB = DUE_ORDER[dueState(b.expectedReply, state.today)];
          if (stateA !== stateB) return stateA - stateB;
          return a.expectedReply.localeCompare(b.expectedReply);
        })
      : [];

  return (
    <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-600">Waiting to hear back</p>
          <h2 className="mt-1 text-xl font-semibold">Follow-ups</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Called a company and they said “next week”? Add them here with the
            date you expect an answer. Due and overdue rows light up below, and
            the tracker emails a reminder on the day (see the note at the
            bottom for the one-time reminder setup).
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={state.status === "loading"}
          className="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {state.status === "loading" ? "Loading..." : "Refresh"}
        </button>
      </div>

      <form
        onSubmit={add}
        className="mt-6 grid gap-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 sm:grid-cols-[2fr_1fr_2fr_1fr_auto]"
      >
        <input
          value={company}
          onChange={(event) => setCompany(event.target.value)}
          maxLength={200}
          placeholder="Company"
          className="rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <input
          type="date"
          value={expectedReply}
          onChange={(event) => setExpectedReply(event.target.value)}
          className="rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          placeholder="Note (optional) — e.g. spoke to Jane, call back Tuesday"
          className="rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <select
          value={addedBy}
          onChange={(event) => setAddedBy(event.target.value)}
          className="rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        >
          {TEAM_MEMBERS.map((member) => (
            <option key={member.name} value={member.name}>
              {member.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={
            saveState.status === "saving" || !company.trim() || !expectedReply
          }
          className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {saveState.status === "saving" ? "Adding..." : "Add"}
        </button>
      </form>
      {saveState.status === "error" && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
          {saveState.message}
        </p>
      )}

      <div className="mt-6" aria-live="polite">
        {state.status === "error" && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            {state.message}
          </p>
        )}
        {state.status === "success" && rows.length === 0 && (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Nothing pending. Add a company after you call them.
          </p>
        )}
        {state.status === "success" && rows.length > 0 && (
          <div className="grid gap-2">
            {rows.map((row) => {
              const due = dueState(row.expectedReply, state.today);
              const heard = row.status === "Heard back";
              const rowState: SaveState =
                rowStates[row.rowNumber] ?? { status: "idle" };

              return (
                <article
                  key={row.rowNumber}
                  className={`rounded-xl border p-3 ${
                    heard
                      ? "border-slate-200 bg-slate-50"
                      : due === "overdue"
                        ? "border-red-300 bg-red-50/60"
                        : due === "today"
                          ? "border-amber-300 bg-amber-50/60"
                          : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">
                      {row.company}
                    </span>
                    {heard ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                        Heard back
                      </span>
                    ) : due === "overdue" ? (
                      <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800 ring-1 ring-red-300">
                        Overdue · expected {row.expectedReply}
                      </span>
                    ) : due === "today" ? (
                      <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300">
                        Due today
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                        Expected {row.expectedReply || "—"}
                      </span>
                    )}
                    {row.addedBy && (
                      <span className="text-xs text-slate-500">
                        added by {row.addedBy}
                        {row.addedOn ? ` · ${row.addedOn}` : ""}
                      </span>
                    )}
                  </div>
                  {row.note && (
                    <p className="mt-1 text-sm text-slate-600">{row.note}</p>
                  )}
                  {!heard && (
                    <button
                      type="button"
                      onClick={() => heardBack(row)}
                      disabled={rowState.status === "saving"}
                      className="mt-2 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-400"
                    >
                      {rowState.status === "saving" ? "Saving..." : "Heard back"}
                    </button>
                  )}
                  {rowState.status === "error" && (
                    <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                      {rowState.message}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      <p className="mt-6 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        Email reminders: a small script inside the tracker spreadsheet checks
        this list every morning and emails when a date arrives (one-time setup
        in Extensions → Apps Script). This app itself never sends email.
      </p>
    </section>
  );
}
