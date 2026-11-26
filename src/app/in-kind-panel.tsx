"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { buildGmailComposeLink } from "@/lib/gmail-compose";
import {
  classifyContactInfo,
  DEFAULT_IN_KIND_SUBJECT,
  DEFAULT_IN_KIND_TEMPLATE,
  extractEmailAddress,
  IN_KIND_CONTACTED_STATUS,
  isInKindContacted,
  type InKindRow,
} from "@/lib/in-kind";
import { TEAM_MEMBERS } from "@/lib/sheet-writes";

import { MISA_MAILBOX, type SaveState } from "./sheet-save";

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; tabTitle: string; rows: InKindRow[] }
  | { status: "error"; message: string };

type DraftState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      subject: string;
      body: string;
      pastStudentClubSponsor: boolean;
      sponsorHistorySourceUrl: string | null;
      approved: boolean;
    }
  | { status: "error"; message: string };

type AddCompanyState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "warning"; similarCompanies: string[] }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type GmailState =
  | { status: "loading" }
  | { status: "available"; sender: string }
  | { status: "unavailable"; sender: string }
  | { status: "error"; message: string };

type DirectSendState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; message: string; warning: boolean }
  | { status: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The in-kind flow: contacts already exist in the shared Master Outreach
 * Tracker. OpenRouter drafts from the approved template, and verified past
 * student-club sponsors receive a brief acknowledgment. The user reviews the
 * result before opening Gmail or copying it to a web form.
 */
export function InKindPanel({ active }: { active: boolean }) {
  const [list, setList] = useState<ListState>({ status: "idle" });
  const [saveStates, setSaveStates] = useState<Record<number, SaveState>>({});
  const [draftStates, setDraftStates] = useState<Record<number, DraftState>>({});
  const [senderName, setSenderName] = useState<string>(TEAM_MEMBERS[0].name);
  const [subject, setSubject] = useState(DEFAULT_IN_KIND_SUBJECT);
  const [template, setTemplate] = useState(DEFAULT_IN_KIND_TEMPLATE);
  const [hideSent, setHideSent] = useState(false);
  const [contactedByFilter, setContactedByFilter] = useState("all");
  const [contactedDateFilter, setContactedDateFilter] = useState("all");
  const [newCompany, setNewCompany] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [addCompanyState, setAddCompanyState] = useState<AddCompanyState>({
    status: "idle",
  });
  const [gmailState, setGmailState] = useState<GmailState>({ status: "loading" });
  const [sendStates, setSendStates] = useState<Record<number, DirectSendState>>(
    {},
  );
  const requestedRef = useRef(false);
  const listGenerationRef = useRef(0);
  const draftGenerationRef = useRef(0);

  const load = useCallback(async () => {
    listGenerationRef.current += 1;
    draftGenerationRef.current += 1;
    setList({ status: "loading" });
    setDraftStates({});
    setSaveStates({});
    setSendStates({});

    try {
      const response = await fetch("/api/in-kind", { cache: "no-store" });
      const data = (await response.json()) as {
        tabTitle?: string;
        rows?: InKindRow[];
        error?: string;
      };

      if (!response.ok || !Array.isArray(data.rows) || !data.tabTitle) {
        throw new Error(data.error ?? "The in-kind list could not be loaded.");
      }

      setList({ status: "success", tabTitle: data.tabTitle, rows: data.rows });
    } catch (error) {
      setList({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The in-kind list could not be loaded.",
      });
    }
  }, []);

  const loadGmailStatus = useCallback(async () => {
    setGmailState({ status: "loading" });
    try {
      const response = await fetch("/api/gmail/status", { cache: "no-store" });
      const data: unknown = await response.json();
      const result = isRecord(data) ? data : {};
      if (!response.ok || typeof result.sender !== "string") {
        throw new Error("Gmail status could not be checked.");
      }
      setGmailState(
        result.configured === true
          ? { status: "available", sender: result.sender }
          : { status: "unavailable", sender: result.sender },
      );
    } catch (error) {
      setGmailState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Gmail status could not be checked.",
      });
    }
  }, []);

  // Loads once, the first time the tab is opened; Refresh re-reads after.
  useEffect(() => {
    if (active && !requestedRef.current) {
      requestedRef.current = true;
      void load();
      void loadGmailStatus();
    }
  }, [active, load, loadGmailStatus]);

  async function markSent(row: InKindRow) {
    if (saveStates[row.rowNumber]?.status === "saving") return;
    const requestGeneration = listGenerationRef.current;
    setSaveStates((current) => ({
      ...current,
      [row.rowNumber]: { status: "saving" },
    }));

    try {
      const response = await fetch("/api/in-kind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          company: row.company,
          contactedBy: senderName,
        }),
      });
      const data = (await response.json()) as { saved?: boolean; error?: string };

      if (!response.ok || !data.saved) {
        throw new Error(data.error ?? "The sheet update failed.");
      }

      if (requestGeneration !== listGenerationRef.current) return;
      const today = new Date().toLocaleDateString("en-CA");
      setSaveStates((current) => ({
        ...current,
        [row.rowNumber]: { status: "saved", detail: "Recorded in the sheet." },
      }));
      setList((current) =>
        current.status === "success"
          ? {
              ...current,
              rows: current.rows.map((item) =>
                item.rowNumber === row.rowNumber &&
                item.company === row.company
                  ? {
                      ...item,
                      status: IN_KIND_CONTACTED_STATUS,
                      contactedBy: senderName,
                      dateOfReq: today,
                    }
                  : item,
              ),
            }
          : current,
      );
    } catch (error) {
      if (requestGeneration !== listGenerationRef.current) return;
      setSaveStates((current) => ({
        ...current,
        [row.rowNumber]: {
          status: "error",
          message:
            error instanceof Error ? error.message : "The sheet update failed.",
        },
      }));
    }
  }

  async function draftEmail(row: InKindRow) {
    if (draftStates[row.rowNumber]?.status === "loading") return;
    const requestGeneration = draftGenerationRef.current;
    setDraftStates((current) => ({
      ...current,
      [row.rowNumber]: { status: "loading" },
    }));

    try {
      const response = await fetch("/api/in-kind/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          company: row.company,
          senderName,
          subject,
          template,
        }),
      });
      const data: unknown = await response.json();
      const responseBody = isRecord(data) ? data : {};
      const draft = isRecord(responseBody.draft) ? responseBody.draft : null;

      if (
        !response.ok ||
        !draft ||
        typeof draft.subject !== "string" ||
        typeof draft.body !== "string"
      ) {
        throw new Error(
          typeof responseBody.error === "string"
            ? responseBody.error
            : "The email draft could not be generated.",
        );
      }

      const draftedSubject = draft.subject;
      const draftedBody = draft.body;
      if (requestGeneration !== draftGenerationRef.current) return;
      setDraftStates((current) => ({
        ...current,
        [row.rowNumber]: {
          status: "ready",
          subject: draftedSubject,
          body: draftedBody,
          pastStudentClubSponsor: draft.pastStudentClubSponsor === true,
          sponsorHistorySourceUrl:
            typeof draft.sponsorHistorySourceUrl === "string"
              ? draft.sponsorHistorySourceUrl
              : null,
          approved: false,
        },
      }));
    } catch (error) {
      if (requestGeneration !== draftGenerationRef.current) return;
      setDraftStates((current) => ({
        ...current,
        [row.rowNumber]: {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "The email draft could not be generated.",
        },
      }));
    }
  }

  function invalidateDrafts() {
    draftGenerationRef.current += 1;
    setDraftStates({});
  }

  function updateDraft(
    rowNumber: number,
    field: "subject" | "body",
    value: string,
  ) {
    setDraftStates((current) => {
      const existing = current[rowNumber];
      if (existing?.status !== "ready") return current;
      return {
        ...current,
        [rowNumber]: { ...existing, [field]: value, approved: false },
      };
    });
  }

  function approveDraft(rowNumber: number) {
    setDraftStates((current) => {
      const existing = current[rowNumber];
      if (existing?.status !== "ready") return current;
      return {
        ...current,
        [rowNumber]: { ...existing, approved: true },
      };
    });
  }

  async function addCompany(confirmSimilar: boolean) {
    if (addCompanyState.status === "saving") return;
    setAddCompanyState({ status: "saving" });

    try {
      const response = await fetch("/api/in-kind", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: newCompany,
          contactInfo: newEmail,
          confirmSimilar,
        }),
      });
      const data: unknown = await response.json();
      const responseBody = isRecord(data) ? data : {};
      const similarCompanies = Array.isArray(responseBody.similarCompanies)
        ? responseBody.similarCompanies.filter(
            (value): value is string => typeof value === "string",
          )
        : [];

      if (response.status === 409 && similarCompanies.length > 0) {
        setAddCompanyState({ status: "warning", similarCompanies });
        return;
      }
      if (!response.ok || responseBody.added !== true) {
        throw new Error(
          typeof responseBody.error === "string"
            ? responseBody.error
            : "The company could not be added.",
        );
      }

      const addedCompany = newCompany.trim();
      setNewCompany("");
      setNewEmail("");
      await load();
      setAddCompanyState({
        status: "success",
        message: `${addedCompany} was added to Google Sheets.`,
      });
    } catch (error) {
      setAddCompanyState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The company could not be added.",
      });
    }
  }

  async function sendEmail(row: InKindRow, draft: Extract<DraftState, { status: "ready" }>) {
    if (!draft.approved || sendStates[row.rowNumber]?.status === "sending") return;
    const recipient = extractEmailAddress(row.contactInfo);
    if (!recipient) return;
    const confirmed = window.confirm(
      `Send this approved email to ${recipient} from ${MISA_MAILBOX}?`,
    );
    if (!confirmed) return;

    setSendStates((current) => ({
      ...current,
      [row.rowNumber]: { status: "sending" },
    }));

    try {
      const response = await fetch("/api/in-kind/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          company: row.company,
          to: recipient,
          subject: draft.subject,
          body: draft.body,
          senderName,
          confirmed: true,
        }),
      });
      const data: unknown = await response.json();
      const result = isRecord(data) ? data : {};
      if (!response.ok || result.sent !== true) {
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "Gmail could not send the message.",
        );
      }

      const warning = typeof result.warning === "string" ? result.warning : null;
      setSendStates((current) => ({
        ...current,
        [row.rowNumber]: {
          status: "sent",
          message: warning ?? "Email sent and recorded in Google Sheets.",
          warning: Boolean(warning),
        },
      }));
      const today = new Date().toLocaleDateString("en-CA");
      setList((current) =>
        current.status === "success"
          ? {
              ...current,
              rows: current.rows.map((item) =>
                item.rowNumber === row.rowNumber
                  ? {
                      ...item,
                      status: IN_KIND_CONTACTED_STATUS,
                      contactedBy: senderName,
                      dateOfReq: today,
                    }
                  : item,
              ),
            }
          : current,
      );
    } catch (error) {
      setSendStates((current) => ({
        ...current,
        [row.rowNumber]: {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Gmail could not send the message.",
        },
      }));
    }
  }

  // Phone-only rows are skipped outright: this outreach is email or web form.
  const phoneRows =
    list.status === "success"
      ? list.rows.filter(
          (row) => classifyContactInfo(row.contactInfo) === "phone",
        ).length
      : 0;
  const contactedByOptions =
    list.status === "success"
      ? Array.from(
          new Set(
            list.rows
              .map((row) => row.contactedBy.trim())
              .filter(Boolean),
          ),
        ).sort((a, b) => a.localeCompare(b))
      : [];
  const contactedDateOptions =
    list.status === "success"
      ? Array.from(
          new Set(
            list.rows
              .map((row) => row.dateOfReq.trim())
              .filter(Boolean),
          ),
        ).sort((a, b) => b.localeCompare(a))
      : [];
  const visibleRows =
    list.status === "success"
      ? [...list.rows]
          .filter((row) => classifyContactInfo(row.contactInfo) !== "phone")
          .sort((a, b) => Number(b.prev) - Number(a.prev))
          .filter((row) => !hideSent || !row.status)
          .filter((row) =>
            contactedByFilter === "all"
              ? true
              : contactedByFilter === "unassigned"
                ? !row.contactedBy
                : row.contactedBy === contactedByFilter,
          )
          .filter((row) =>
            contactedDateFilter === "all"
              ? true
              : contactedDateFilter === "no-date"
                ? !row.dateOfReq
                : row.dateOfReq === contactedDateFilter,
          )
      : [];

  return (
    <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-600">
            Master Outreach Tracker
          </p>
          <h2 className="mt-1 text-xl font-semibold">In-kind sponsors</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Contacts already exist in the shared sheet. Draft email asks
            OpenRouter to prepare the message, then you can review and edit it
            before approval. Direct Gmail sends record the date, status, your
            name, and Gmail message ID.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={list.status === "loading"}
          className="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {list.status === "loading" ? "Loading..." : "Refresh"}
        </button>
      </div>

      <form
        className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void addCompany(false);
        }}
      >
        <h3 className="text-sm font-semibold text-slate-900">
          Add company and email
        </h3>
        <p className="mt-1 text-xs text-slate-600">
          This adds a new row to the in-kind Google Sheet. Similar names trigger
          a warning but can still be added.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="text-sm font-medium text-slate-700">
            Company
            <input
              value={newCompany}
              onChange={(event) => {
                setNewCompany(event.target.value);
                setAddCompanyState({ status: "idle" });
              }}
              required
              maxLength={200}
              disabled={addCompanyState.status === "saving"}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Email
            <input
              type="email"
              value={newEmail}
              onChange={(event) => {
                setNewEmail(event.target.value);
                setAddCompanyState({ status: "idle" });
              }}
              required
              maxLength={320}
              disabled={addCompanyState.status === "saving"}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100"
            />
          </label>
          <button
            type="submit"
            disabled={addCompanyState.status === "saving"}
            className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {addCompanyState.status === "saving" ? "Checking..." : "Add company"}
          </button>
        </div>

        <div className="mt-3" aria-live="polite">
          {addCompanyState.status === "warning" && (
            <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
              <p>
                Possible existing match: {addCompanyState.similarCompanies.join(", ")}.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void addCompany(true)}
                  className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-600"
                >
                  Add anyway
                </button>
                <button
                  type="button"
                  onClick={() => setAddCompanyState({ status: "idle" })}
                  className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {addCompanyState.status === "success" && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
              {addCompanyState.message}
            </p>
          )}
          {addCompanyState.status === "error" && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
              {addCompanyState.message}
            </p>
          )}
        </div>
      </form>

      <div className="mt-6 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Sender
            <select
              value={senderName}
              onChange={(event) => {
                setSenderName(event.target.value);
                invalidateDrafts();
              }}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              {TEAM_MEMBERS.map((member) => (
                <option key={member.name} value={member.name}>
                  {member.name} — {member.role}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Subject
            <input
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                invalidateDrafts();
              }}
              maxLength={300}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </label>
        </div>
        <label className="mt-4 block text-sm font-medium text-slate-700">
          Message template
          <textarea
            value={template}
            onChange={(event) => {
              setTemplate(event.target.value);
              invalidateDrafts();
            }}
            maxLength={5000}
            rows={10}
            className="mt-2 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </label>
        <p className="mt-2 text-xs text-slate-500">
          {"{company}"}, {"{senderName}"}, {"{senderRole}"} and{" "}
          {"{senderRoleIntro}"} are filled in per row. Keep the{" "}
          {"{inKindAsk}"} slot where the request should appear. OpenRouter
          selects an approved ask for that slot. The [insert—gift cards,
          merchandise, vouchers, etc.] part remains for you to customize. A
          verified past student-club sponsor receives a short, general
          acknowledgment without naming the club. Direct sending requires draft
          approval and a final confirmation.
        </p>
        <p className="mt-2 text-xs font-medium text-slate-600" aria-live="polite">
          {gmailState.status === "loading" && "Checking Gmail connection..."}
          {gmailState.status === "available" &&
            `Direct sending active: ${gmailState.sender}`}
          {gmailState.status === "unavailable" &&
            "Direct sending is not configured. Open in Gmail remains available."}
          {gmailState.status === "error" && gmailState.message}
        </p>
      </div>

      <div className="mt-6" aria-live="polite">
        {list.status === "idle" && (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Open this tab to load the in-kind list.
          </p>
        )}
        {list.status === "loading" && (
          <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-800 ring-1 ring-indigo-200">
            Reading the in-kind tab...
          </p>
        )}
        {list.status === "error" && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            {list.message}
          </p>
        )}

        {list.status === "success" && (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm text-slate-600">
                {list.rows.length} companies in “{list.tabTitle}” ·{" "}
                {list.rows.filter((row) => isInKindContacted(row.status)).length} contacted so far
                {phoneRows > 0 && ` · ${phoneRows} skipped (phone number only)`}
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-slate-700">
                  Contacted by
                  <select
                    value={contactedByFilter}
                    onChange={(event) => setContactedByFilter(event.target.value)}
                    className="mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-normal"
                  >
                    <option value="all">Everyone</option>
                    <option value="unassigned">Not assigned</option>
                    {contactedByOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-medium text-slate-700">
                  Contacted date
                  <select
                    value={contactedDateFilter}
                    onChange={(event) => setContactedDateFilter(event.target.value)}
                    className="mt-1 block max-w-52 rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-normal"
                  >
                    <option value="all">All dates</option>
                    <option value="no-date">No date</option>
                    {contactedDateOptions.map((date) => (
                      <option key={date} value={date}>
                        {date}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={hideSent}
                    onChange={(event) => setHideSent(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                  />
                  Hide already contacted
                </label>
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-500">
              Showing {visibleRows.length} matching companies.
            </p>

            <div className="mt-3 grid gap-2">
              {visibleRows.map((row) => {
                const kind = classifyContactInfo(row.contactInfo);
                const recipient = extractEmailAddress(row.contactInfo);
                const saveState: SaveState =
                  saveStates[row.rowNumber] ?? { status: "idle" };
                const draftState: DraftState =
                  draftStates[row.rowNumber] ?? { status: "idle" };
                const sendState: DirectSendState =
                  sendStates[row.rowNumber] ?? { status: "idle" };
                const compose =
                  kind === "email" &&
                  draftState.status === "ready" &&
                  draftState.approved
                    ? buildGmailComposeLink({
                        sendAs: MISA_MAILBOX,
                        to: recipient,
                        subject: draftState.subject,
                        body: draftState.body,
                      })
                    : null;

                return (
                  <article
                    key={row.rowNumber}
                    className="rounded-xl border border-slate-200 bg-white p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">
                        {row.company}
                      </span>
                      {row.prev && (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          Said yes last year
                        </span>
                      )}
                      {row.status && (
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                          {isInKindContacted(row.status) ? IN_KIND_CONTACTED_STATUS : row.status}
                          {row.contactedBy ? ` by ${row.contactedBy}` : ""}
                          {row.dateOfReq ? ` · ${row.dateOfReq}` : ""}
                        </span>
                      )}
                      <span className="text-xs text-slate-500">
                        {row.contactInfo || "no contact info"}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => draftEmail(row)}
                        disabled={draftState.status === "loading"}
                        className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                      >
                        {draftState.status === "loading"
                          ? "Drafting..."
                          : draftState.status === "ready"
                            ? "Redraft email"
                            : "Draft email"}
                      </button>
                      {kind === "email" &&
                        gmailState.status === "available" &&
                        draftState.status === "ready" &&
                        draftState.approved && (
                          <button
                            type="button"
                            onClick={() => void sendEmail(row, draftState)}
                            disabled={
                              sendState.status === "sending" ||
                              sendState.status === "sent"
                            }
                            className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            {sendState.status === "sending"
                              ? "Sending..."
                              : sendState.status === "sent"
                                ? "Contacted"
                                : "Send email"}
                          </button>
                        )}
                      {compose &&
                        draftState.status === "ready" &&
                        gmailState.status !== "available" && (
                        <a
                          href={compose.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50"
                        >
                          Open in Gmail
                        </a>
                      )}
                      {kind === "url" &&
                        draftState.status === "ready" &&
                        draftState.approved && (
                        <a
                          href={
                            /^https?:\/\//i.test(row.contactInfo)
                              ? row.contactInfo
                              : `https://${row.contactInfo}`
                          }
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50"
                        >
                          Open web form
                        </a>
                      )}
                      {kind !== "email" &&
                        draftState.status === "ready" &&
                        draftState.approved && (
                        <button
                          type="button"
                          onClick={() =>
                            navigator.clipboard.writeText(draftState.body)
                          }
                          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                        >
                          Copy message
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => markSent(row)}
                        hidden={kind === "email" && gmailState.status === "available"}
                        disabled={
                          saveState.status === "saving" ||
                          draftState.status !== "ready" ||
                          !draftState.approved
                        }
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        {saveState.status === "saving" ? "Saving..." : "Mark contacted"}
                      </button>
                      {compose?.bodyOmitted && (
                        <span className="text-xs text-amber-800">
                          Message too long to prefill — use Copy message.
                        </span>
                      )}
                    </div>

                    {draftState.status === "ready" && (
                      <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
                        {draftState.pastStudentClubSponsor && (
                          <p className="mb-3 text-xs font-medium text-emerald-700">
                            Past student-club sponsorship matched. The draft
                            includes a general acknowledgment.{" "}
                            {draftState.sponsorHistorySourceUrl && (
                              <a
                                href={draftState.sponsorHistorySourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                View source
                              </a>
                            )}
                          </p>
                        )}
                        <label className="block text-xs font-semibold text-slate-700">
                          Subject
                          <input
                            value={draftState.subject}
                            onChange={(event) =>
                              updateDraft(
                                row.rowNumber,
                                "subject",
                                event.target.value,
                              )
                            }
                            maxLength={300}
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 font-normal outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="mt-3 block text-xs font-semibold text-slate-700">
                          Email
                          <textarea
                            value={draftState.body}
                            onChange={(event) =>
                              updateDraft(
                                row.rowNumber,
                                "body",
                                event.target.value,
                              )
                            }
                            maxLength={5000}
                            rows={12}
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 font-normal leading-5 outline-none focus:border-indigo-500"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => approveDraft(row.rowNumber)}
                          disabled={draftState.approved}
                          className="mt-3 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-default disabled:bg-emerald-600"
                        >
                          {draftState.approved
                            ? "Draft approved"
                            : "Approve draft"}
                        </button>
                        {!draftState.approved && (
                          <p className="mt-2 text-xs text-slate-600">
                            Approve the draft to unlock sending, Gmail fallback,
                            copy, and Mark contacted.
                          </p>
                        )}
                      </div>
                    )}
                    {draftState.status === "error" && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                        Draft failed: {draftState.message}
                      </p>
                    )}
                    {saveState.status === "saved" && (
                      <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
                        {saveState.detail}
                      </p>
                    )}
                    {saveState.status === "error" && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                        Save failed: {saveState.message}
                      </p>
                    )}
                    {sendState.status === "sent" && (
                      <p
                        className={`mt-2 rounded-lg px-3 py-2 text-xs ring-1 ${
                          sendState.warning
                            ? "bg-amber-50 text-amber-900 ring-amber-200"
                            : "bg-emerald-50 text-emerald-800 ring-emerald-200"
                        }`}
                      >
                        {sendState.message}
                      </p>
                    )}
                    {sendState.status === "error" && (
                      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                        Send failed: {sendState.message}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
