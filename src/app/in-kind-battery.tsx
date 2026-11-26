"use client";

import { useEffect, useState } from "react";
import { IN_KIND_GOAL, type InKindSponsor } from "@/lib/in-kind-inventory";
import { ProgressBattery } from "./progress-battery";

type Progress =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; total: number; unpriced: number; sponsors: InKindSponsor[] };

const currency = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });

export function InKindBattery({ active }: { active: boolean }) {
  const [progress, setProgress] = useState<Progress>({ kind: "loading" });

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    async function loadProgress() {
      try {
        const response = await fetch("/api/in-kind/inventory", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as Partial<Extract<Progress, { kind: "ready" }>>;
        const { total, unpriced, sponsors } = data;
        if (!response.ok || typeof total !== "number" || typeof unpriced !== "number" ||
            !Array.isArray(sponsors)) {
          throw new Error();
        }
        if (!controller.signal.aborted) {
          setProgress({
            kind: "ready",
            total,
            unpriced,
            sponsors,
          });
        }
      } catch {
        if (!controller.signal.aborted) setProgress({ kind: "error" });
      }
    }

    void loadProgress();
    return () => controller.abort();
  }, [active]);

  const ready = progress.kind === "ready" ? progress : null;
  const percent = ready ? Math.floor((ready.total / IN_KIND_GOAL) * 100) : 0;

  return (
    <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <p className="text-sm font-medium text-indigo-600">Season goal</p>
      <h2 className="mt-1 text-xl font-semibold">In-kind goal battery</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Uses single dollar amounts from the In-Kind Inventory. All values are in CAD.
      </p>
      <div className="mt-6 flex flex-col items-center" aria-live="polite">
        {ready ? (
          <>
            <ProgressBattery
              percent={Math.min(100, percent)}
              full={ready.total >= IN_KIND_GOAL}
              label={`In-kind goal: ${currency.format(ready.total)} of ${currency.format(IN_KIND_GOAL)}`}
            />
            <p className="mt-3 text-xl font-semibold text-slate-900">
              {currency.format(ready.total)} of {currency.format(IN_KIND_GOAL)} · {percent}%
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {ready.total >= IN_KIND_GOAL ? "Goal reached" :
                `${currency.format(IN_KIND_GOAL - ready.total)} to go`}
            </p>
            {ready.unpriced > 0 && (
              <p className="mt-2 text-sm text-slate-600">
                Items excluded because their value is blank, TBD, or not a single amount: {ready.unpriced}.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-600">
            {progress.kind === "loading" ?
              "Loading in-kind inventory…" : "Could not load in-kind inventory."}
          </p>
        )}
      </div>
      {ready && (
        <div className="mt-6">
          <h3 className="mb-3 text-lg font-semibold text-slate-900">In-kind sponsors</h3>
          {ready.sponsors.length === 0 ? (
            <p className="text-sm text-slate-600">No in-kind sponsors recorded yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-100 text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th scope="col" className="px-4 py-3">Sponsor</th>
                    <th scope="col" className="px-4 py-3 text-right">Inventory entries</th>
                    <th scope="col" className="px-4 py-3 text-right">Counted value (CAD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ready.sponsors.map((sponsor) => (
                    <tr key={sponsor.company}>
                      <th scope="row" className="px-4 py-3 font-medium">{sponsor.company}</th>
                      <td className="px-4 py-3 text-right">{sponsor.entries}</td>
                      <td className="px-4 py-3 text-right">
                        {sponsor.valuedEntries === 0 ? "Not valued" : currency.format(sponsor.value)}
                        {sponsor.valuedEntries > 0 && sponsor.valuedEntries < sponsor.entries && (
                          <span className="block text-xs text-slate-500">Partial value</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
