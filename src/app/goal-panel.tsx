"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SPONSORSHIP_GOAL, type SponsorRow } from "@/lib/follow-ups";
import { TEAM_MEMBERS } from "@/lib/sheet-writes";

import { InKindBattery } from "./in-kind-battery";
import { ProgressBattery } from "./progress-battery";
import { type SaveState } from "./sheet-save";

type GoalState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; sponsors: SponsorRow[]; total: number; goal: number }
  | { status: "error"; message: string };

const dollars = (value: number) =>
  value.toLocaleString("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  });

/**
 * The sponsorship battery: every confirmed sponsor charges it toward the
 * season goal. Data lives in the tracker's Sponsors tab, so the sheet stays
 * the source of truth and the battery just renders it.
 */
export function GoalPanel({ active }: { active: boolean }) {
  const [state, setState] = useState<GoalState>({ status: "idle" });
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [sponsor, setSponsor] = useState("");
  const [amount, setAmount] = useState("");
  const [addedBy, setAddedBy] = useState<string>(TEAM_MEMBERS[0].name);
  const requestedRef = useRef(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/sponsors", { cache: "no-store" });
      const data = (await response.json()) as {
        sponsors?: SponsorRow[];
        total?: number;
        goal?: number;
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.sponsors)) {
        throw new Error(data.error ?? "The sponsor list could not be loaded.");
      }
      setState({
        status: "success",
        sponsors: data.sponsors,
        total: data.total ?? 0,
        goal: data.goal ?? SPONSORSHIP_GOAL,
      });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The sponsor list could not be loaded.",
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
      const response = await fetch("/api/sponsors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sponsor, amount, addedBy }),
      });
      const data = (await response.json()) as { saved?: boolean; error?: string };
      if (!response.ok || !data.saved) {
        throw new Error(data.error ?? "The sponsor could not be saved.");
      }
      setSaveState({ status: "saved", detail: `${sponsor} added.` });
      setSponsor("");
      setAmount("");
      void load();
    } catch (error) {
      setSaveState({
        status: "error",
        message:
          error instanceof Error ? error.message : "The sponsor could not be saved.",
      });
    }
  }

  const total = state.status === "success" ? state.total : 0;
  const goal = state.status === "success" ? state.goal : SPONSORSHIP_GOAL;
  const percent = Math.min(100, Math.round((total / goal) * 100));
  const full = total >= goal;

  return (
    <>
    <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <p className="text-sm font-medium text-indigo-600">Season goal</p>
      <h2 className="mt-1 text-xl font-semibold">Sponsorship battery</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
        Every confirmed sponsor charges the battery toward{" "}
        {dollars(goal)}. Amounts live in the tracker&apos;s Sponsors tab.
      </p>

      {/* The battery */}
      <div className="mt-6 flex flex-col items-center">
        <ProgressBattery
          percent={percent}
          full={full}
          label={`Sponsorship progress: ${dollars(total)} of ${dollars(goal)}`}
        />
        <p className="mt-3 text-2xl font-semibold text-slate-900">
          {dollars(total)}{" "}
          <span className="text-base font-medium text-slate-500">
            of {dollars(goal)} · {percent}%
          </span>
        </p>
        {full ? (
          <p className="mt-1 rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200">
            Fully charged — goal reached! 🎉
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-500">
            {dollars(goal - total)} to go
          </p>
        )}
      </div>

      {/* Add a sponsor */}
      <form
        onSubmit={add}
        className="mt-6 grid gap-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 sm:grid-cols-[2fr_1fr_2fr_auto]"
      >
        <input
          value={sponsor}
          onChange={(event) => setSponsor(event.target.value)}
          maxLength={200}
          placeholder="Sponsor name"
          className="rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          maxLength={20}
          placeholder="Amount ($)"
          inputMode="decimal"
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
          disabled={saveState.status === "saving" || !sponsor.trim() || !amount.trim()}
          className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {saveState.status === "saving" ? "Adding..." : "Add sponsor"}
        </button>
      </form>
      {saveState.status === "error" && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
          {saveState.message}
        </p>
      )}

      {/* Sponsor list */}
      <div className="mt-6" aria-live="polite">
        {state.status === "error" && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            {state.message}
          </p>
        )}
        {state.status === "success" && state.sponsors.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Sponsor</th>
                  <th className="px-4 py-3 font-semibold">Amount</th>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold">Added by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {state.sponsors.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {row.sponsor}
                    </td>
                    <td className="px-4 py-3 text-emerald-700">
                      {dollars(row.amount)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.date || "—"}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.addedBy || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.status === "success" && state.sponsors.length === 0 && (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            No sponsors recorded yet. The first one starts the charge.
          </p>
        )}
      </div>
    </section>
    <InKindBattery active={active} />
    </>
  );
}
