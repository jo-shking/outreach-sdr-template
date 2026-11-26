"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { wasContacted, type RecordedContact } from "./sheet-save";

// Mirrors the /api/already-done response: cached research summaries joined with the
// contacts recorded in the sheet. Opening this view costs nothing — that is its point.
type DoneCompany = {
  companyName: string;
  cachedAt: string | null;
  fitScore: number | null;
  confidenceScore: number | null;
  alignmentSummary: string | null;
  pitchAngle: string | null;
  sourceCount: number;
  personalized: boolean;
  contacts: RecordedContact[];
};

type DoneState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "success";
      companies: DoneCompany[];
      researchedCount: number;
      contactCount: number;
      sheetError: string | null;
    }
  | { status: "error"; message: string };

export function AlreadyDonePanel({ active }: { active: boolean }) {
  const [state, setState] = useState<DoneState>({ status: "idle" });
  const requestedRef = useRef(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });

    try {
      const response = await fetch("/api/already-done", { cache: "no-store" });
      const data = (await response.json()) as {
        companies?: DoneCompany[];
        researchedCount?: number;
        contactCount?: number;
        sheetError?: string | null;
        error?: string;
      };

      if (!response.ok || !Array.isArray(data.companies)) {
        throw new Error(data.error ?? "Completed work could not be loaded.");
      }

      setState({
        status: "success",
        companies: data.companies,
        researchedCount: data.researchedCount ?? 0,
        contactCount: data.contactCount ?? 0,
        sheetError: data.sheetError ?? null,
      });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Completed work could not be loaded.",
      });
    }
  }, []);

  // Loads once, the first time the tab is opened; the Refresh button re-reads after.
  useEffect(() => {
    if (active && !requestedRef.current) {
      requestedRef.current = true;
      void load();
    }
  }, [active, load]);

  return (
    <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-600">Already paid for</p>
          <h2 className="mt-1 text-xl font-semibold">Already done</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Companies whose research is cached and contacts already recorded in the
            sheet. Everything here has been paid for once — re-researching a company
            spends another Exa search, and re-revealing a contact spends another
            Apollo credit. Check this list before spending again.
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

      <div className="mt-6" aria-live="polite">
        {state.status === "idle" && (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Open this tab to load previously completed work.
          </p>
        )}

        {state.status === "loading" && (
          <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-800 ring-1 ring-indigo-200">
            Reading the research cache and the Contacts tab...
          </p>
        )}

        {state.status === "error" && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            {state.message}
          </p>
        )}

        {state.status === "success" && (
          <>
            <p className="text-sm text-slate-600">
              {state.researchedCount} researched{" "}
              {state.researchedCount === 1 ? "company" : "companies"} ·{" "}
              {state.contactCount} recorded{" "}
              {state.contactCount === 1 ? "contact" : "contacts"}
            </p>

            {state.sheetError && (
              <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
                {state.sheetError} The cached research below is still complete.
              </p>
            )}

            {state.companies.length === 0 ? (
              <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                Nothing has been researched or recorded yet.
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                {state.companies.map((company) => (
                  <article
                    key={company.companyName}
                    className="rounded-xl border border-slate-200 bg-white p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900">
                        {company.companyName}
                      </h3>
                      {company.cachedAt ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          Researched{" "}
                          {new Date(company.cachedAt).toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                          Contacts only · no cached research
                        </span>
                      )}
                      {company.cachedAt && !company.personalized && (
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                          Sources only · worth re-running
                        </span>
                      )}
                      {company.fitScore !== null && (
                        <span className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
                          Fit {company.fitScore} · Confidence{" "}
                          {company.confidenceScore ?? "—"}
                        </span>
                      )}
                      {company.sourceCount > 0 && (
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                          {company.sourceCount}{" "}
                          {company.sourceCount === 1 ? "source" : "sources"}
                        </span>
                      )}
                    </div>

                    {company.alignmentSummary && (
                      <div className="mt-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          MISA alignment
                        </h4>
                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          {company.alignmentSummary}
                        </p>
                      </div>
                    )}

                    {company.pitchAngle && (
                      <div className="mt-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Pitch angle
                        </h4>
                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          {company.pitchAngle}
                        </p>
                      </div>
                    )}

                    {company.contacts.length > 0 ? (
                      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
                        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="px-3 py-2 font-semibold">Contact</th>
                              <th className="px-3 py-2 font-semibold">Title</th>
                              <th className="px-3 py-2 font-semibold">Email</th>
                              <th className="px-3 py-2 font-semibold">Status</th>
                              <th className="px-3 py-2 font-semibold">By</th>
                              <th className="px-3 py-2 font-semibold">Date</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white">
                            {company.contacts.map((contact) => (
                              <tr key={contact.contactId}>
                                <td className="px-3 py-2 font-medium text-slate-900">
                                  {contact.linkedinUrl ? (
                                    <a
                                      href={contact.linkedinUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-indigo-700 underline decoration-indigo-200 underline-offset-2 hover:text-indigo-900"
                                    >
                                      {contact.name}
                                    </a>
                                  ) : (
                                    contact.name
                                  )}
                                  {contact.isAlum && (
                                    <span className="ml-2 inline-flex rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200">
                                      SFU
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-slate-600">
                                  {contact.title || "—"}
                                </td>
                                <td className="px-3 py-2 text-slate-600">
                                  {contact.workEmail || "—"}
                                </td>
                                <td className="px-3 py-2">
                                  <span
                                    className={
                                      wasContacted(contact)
                                        ? "rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200"
                                        : "rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600"
                                    }
                                  >
                                    {contact.outreachStatus || "Not started"}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-slate-600">
                                  {contact.reachedOutBy || "—"}
                                </td>
                                <td className="px-3 py-2 text-slate-600">
                                  {contact.dateReachedOut || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-slate-500">
                        No contacts recorded in the sheet yet.
                      </p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
