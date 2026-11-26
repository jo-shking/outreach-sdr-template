"use client";

import { Fragment, useEffect, useState } from "react";

import { inferCompanyDomain } from "@/lib/company-domain";
import { canonicalProfile } from "@/lib/contact-merge";
import { buildGmailComposeLink } from "@/lib/gmail-compose";
import { DEFAULT_MISA_EVENTS, DEFAULT_PARTNERSHIP_FORMATS } from "@/lib/misa-outreach-context";
import { TEAM_MEMBERS } from "@/lib/sheet-writes";

import {
  fetchRecordedContacts,
  findRecordedMatch,
  MISA_MAILBOX,
  saveContactToSheet,
  saveResearchToSheet,
  wasContacted,
  type RecordedContact,
  type SaveState,
} from "./sheet-save";

type Account = {
  companyId: string | null;
  companyName: string | null;
  website: string | null;
  priority: string | null;
  researchStatus: string | null;
};

type Research = {
  companyName: string;
  companyOverview: string | null;
  companyOverviewSourceIds: string[];
  commonRoles: Array<{
    role: string;
    evidence: string;
    sourceIds: string[];
  }>;
  alignmentSummary: string | null;
  alignmentSourceIds: string[];
  pitchAngle: string | null;
  pitchSourceIds: string[];
  partnershipOpportunities: Array<{
    title: string;
    rationale: string;
    sourceIds: string[];
  }>;
  fitScore: number;
  confidenceScore: number;
  confidenceBasis: string;
  claims: Array<{ claim: string; evidence: string; sourceIds: string[] }>;
  limitations: string[];
  sources: Array<{
    id: string;
    title: string | null;
    url: string;
    publishedDate: string | null;
    isOfficial: boolean;
    searchProvider: "Exa" | "OpenRouter native search";
  }>;
};

type AccountsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; accounts: Account[] }
  | { status: "error"; message: string };

type ResearchState =
  | { status: "idle" }
  | { status: "loading"; companyName: string }
  | { status: "success"; research: Research; cachedAt: string | null }
  | { status: "error"; companyName: string; message: string };

type ContactSearch = {
  companyName: string;
  employees: Array<{
    name: string;
    title: string;
    currentCompany: string;
    currentEmploymentEvidence: string;
    linkedinUrl: string;
    location: string | null;
    sourceUrl: string;
    accessedAt: string;
    rolePriority: number;
    sfuConnection: "alumni" | "education" | null;
    sfuEvidence: string | null;
    sources: Array<"Apollo" | "Apify">;
  }>;
  previews?: ApolloPreview[];
  companyDomain?: string | null;
  limitations: string[];
};

type ApolloPreview = {
  apolloId: string;
  firstName: string;
  maskedName: string;
  title: string;
  organizationName: string | null;
  hasEmail: boolean;
  rolePriority: number;
  isTargetRole: boolean;
};

type RevealedContact = {
  name: string | null;
  title: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  linkedinUrl: string | null;
  location: string | null;
  email: {
    value: string;
    status: "verified";
    source: "Apollo";
    accessedAt: string;
  } | null;
};

type RevealState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; contact: RevealedContact; limitations: string[] }
  | { status: "error"; message: string };

type ContactState =
  | { status: "idle" }
  | { status: "loading"; companyName: string }
  | { status: "success"; contacts: ContactSearch }
  | { status: "error"; companyName: string; message: string };

type EmailEnrichment = {
  email: {
    value: string;
    status: "verified";
    source: "Apollo";
    accessedAt: string;
  } | null;
  limitations: string[];
};

type EmailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: EmailEnrichment }
  | { status: "error"; message: string };

type OutreachDraft = {
  subject: string;
  body: string;
  recipientEmail: string | null;
  whyYouSourceIds: string[];
  personalized: boolean;
  violations: string[];
  limitations: string[];
};

type DraftState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; draft: OutreachDraft; edited: string }
  | { status: "error"; message: string };

type LinkedInNote = {
  note: string;
  sourceIds: string[];
  personalized: boolean;
  violations: string[];
  limitations: string[];
};

type NoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; draft: LinkedInNote; edited: string }
  | { status: "error"; message: string };

type DraftTarget = {
  key: string;
  name: string;
  title: string;
  currentCompany: string;
  currentEmploymentEvidence: string;
  sfuConnection: "alumni" | "education" | null;
  sfuEvidence: string | null;
  linkedinUrl: string | null;
  recipientEmail: string | null;
};

const LINKEDIN_NOTE_LIMIT = 300;

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function parseEmailEnrichment(value: unknown): EmailEnrichment | null {
  const data = objectRecord(value);
  if (!data || !Array.isArray(data.limitations)) return null;

  const limitations = data.limitations.filter(
    (item): item is string => typeof item === "string",
  );
  if (data.email === null) return { email: null, limitations };

  const email = objectRecord(data.email);
  if (
    !email ||
    typeof email.value !== "string" ||
    email.status !== "verified" ||
    email.source !== "Apollo" ||
    typeof email.accessedAt !== "string"
  ) {
    return null;
  }

  return {
    email: {
      value: email.value,
      status: email.status,
      source: email.source,
      accessedAt: email.accessedAt,
    },
    limitations,
  };
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseOutreachDraft(value: unknown): OutreachDraft | null {
  const draft = objectRecord(objectRecord(value)?.draft);
  if (
    !draft ||
    typeof draft.subject !== "string" ||
    typeof draft.body !== "string" ||
    typeof draft.personalized !== "boolean"
  ) {
    return null;
  }

  return {
    subject: draft.subject,
    body: draft.body,
    recipientEmail:
      typeof draft.recipientEmail === "string" ? draft.recipientEmail : null,
    whyYouSourceIds: stringList(draft.whyYouSourceIds),
    personalized: draft.personalized,
    violations: stringList(draft.violations),
    limitations: stringList(draft.limitations),
  };
}

function parseLinkedInNote(value: unknown): LinkedInNote | null {
  const draft = objectRecord(objectRecord(value)?.draft);
  if (
    !draft ||
    typeof draft.note !== "string" ||
    typeof draft.personalized !== "boolean"
  ) {
    return null;
  }

  return {
    note: draft.note,
    sourceIds: stringList(draft.sourceIds),
    personalized: draft.personalized,
    violations: stringList(draft.violations),
    limitations: stringList(draft.limitations),
  };
}

const DEFAULT_SENDER_NAME = "Alex Example";
const DEFAULT_SENDER_ROLE = "Director of Corporate Relations";

export function AccountsPanel() {
  const [state, setState] = useState<AccountsState>({ status: "idle" });
  const [researchState, setResearchState] = useState<ResearchState>({
    status: "idle",
  });
  const [contactState, setContactState] = useState<ContactState>({
    status: "idle",
  });
  const [senderName, setSenderName] = useState(DEFAULT_SENDER_NAME);
  // The role always comes from the roster, so a draft is never signed with the wrong
  // role and the sheet's Reached Out By values cannot drift from the dropdown.
  const senderRole =
    TEAM_MEMBERS.find((member) => member.name === senderName)?.role ??
    DEFAULT_SENDER_ROLE;
  const [misaEvents, setMisaEvents] = useState(DEFAULT_MISA_EVENTS);
  const [partnershipFormats, setPartnershipFormats] = useState(
    DEFAULT_PARTNERSHIP_FORMATS,
  );

  async function loadAccounts() {
    if (state.status === "loading") return;
    setState({ status: "loading" });

    try {
      const response = await fetch("/api/accounts", { cache: "no-store" });
      const data = (await response.json()) as {
        accounts?: Account[];
        error?: string;
      };

      if (!response.ok || !data.accounts) {
        throw new Error(data.error ?? "The account list could not be loaded.");
      }

      setState({ status: "success", accounts: data.accounts });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The account list could not be loaded.",
      });
    }
  }

  async function researchAccount(account: Account, refresh = false) {
    if (!account.companyName || researchState.status === "loading") return;
    setResearchState({ status: "loading", companyName: account.companyName });

    try {
      const response = await fetch("/api/research-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: account.companyId,
          companyName: account.companyName,
          website: account.website,
          misaEvents,
          partnershipFormats,
          // Forces a fresh Exa and OpenRouter run, bypassing the cached result.
          refresh,
        }),
      });
      const data = (await response.json()) as {
        research?: Research;
        cachedAt?: string | null;
        error?: string;
      };

      if (!response.ok || !data.research) {
        throw new Error(data.error ?? "The company research failed.");
      }

      setResearchState({
        status: "success",
        research: data.research,
        cachedAt: data.cachedAt ?? null,
      });
    } catch (error) {
      setResearchState({
        status: "error",
        companyName: account.companyName,
        message:
          error instanceof Error ? error.message : "The company research failed.",
      });
    }
  }

  async function findContacts(account: Account) {
    if (!account.companyName || contactState.status === "loading") return;
    setContactState({ status: "loading", companyName: account.companyName });

    try {
      const researched =
        researchState.status === "success" &&
        researchState.research.companyName === account.companyName
          ? researchState.research
          : null;
      const linkedinCompanyUrl =
        researched?.sources.find((source) =>
          source.url.includes("linkedin.com/company/"),
        )?.url ?? null;
      const researchedDomain = researched
        ? inferCompanyDomain(
            researched.sources.map((source) => source.url),
            account.companyName,
          )
        : null;
      const response = await fetch("/api/search-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: account.companyName,
          linkedinCompanyUrl,
          // Apollo's lead search is domain-based. When the sheet has no website, fall
          // back to the domain Exa already surfaced during research rather than skipping
          // Apollo entirely.
          website: account.website ?? researchedDomain,
        }),
      });
      const data = (await response.json()) as ContactSearch & { error?: string };

      if (!response.ok || !Array.isArray(data.employees)) {
        throw new Error(data.error ?? "The contact search failed.");
      }

      setContactState({ status: "success", contacts: data });
    } catch (error) {
      setContactState({
        status: "error",
        companyName: account.companyName,
        message:
          error instanceof Error ? error.message : "The contact search failed.",
      });
    }
  }

  return (
    <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-600">Google Sheets</p>
          <h2 className="mt-1 text-xl font-semibold">Accounts</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Read companies from Google Sheets, research an account, and find current
            employees. Use the Save buttons to write research and contacts back to
            the tracker; nothing is written without them.
          </p>
        </div>
        <button
          type="button"
          onClick={loadAccounts}
          disabled={state.status === "loading"}
          className="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {state.status === "loading" ? "Loading..." : "Load accounts"}
        </button>
      </div>

      <div className="mt-6 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
        <h3 className="font-semibold text-slate-900">MISA research context</h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Pre-filled from the 2026-2027 MISA Partnership Package. Edit it before
          researching when event plans change. It guides recommendations, is not
          evidence about a company, and stays only in browser memory until refresh.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Events and audiences
            <textarea
              value={misaEvents}
              onChange={(event) => setMisaEvents(event.target.value)}
              maxLength={5000}
              rows={12}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Partnership opportunities MISA can offer
            <textarea
              value={partnershipFormats}
              onChange={(event) => setPartnershipFormats(event.target.value)}
              maxLength={5000}
              rows={12}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </label>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">
            Sender
            <select
              value={senderName}
              onChange={(event) => setSenderName(event.target.value)}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              {TEAM_MEMBERS.map((member) => (
                <option key={member.name} value={member.name}>
                  {member.name} — {member.role}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Used for the signature in generated drafts and for Reached Out By when a
          contact is saved to the sheet. Nothing is sent from this app; drafts are
          copied out by hand.
        </p>
      </div>

      <div className="mt-6" aria-live="polite">
        {state.status === "idle" && (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Select Load accounts to retrieve the Companies tab.
          </p>
        )}

        {state.status === "error" && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            {state.message}
          </p>
        )}

        {state.status === "success" && state.accounts.length === 0 && (
          <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
            Connection working. The Companies tab currently has no account rows.
          </p>
        )}

        {state.status === "success" && state.accounts.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Company</th>
                  <th className="px-4 py-3 font-semibold">Website</th>
                  <th className="px-4 py-3 font-semibold">Priority</th>
                  <th className="px-4 py-3 font-semibold">Research status</th>
                  <th className="px-4 py-3 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {state.accounts.map((account, index) => {
                  const isResearching =
                    researchState.status === "loading" &&
                    researchState.companyName === account.companyName;
                  const showsResearch =
                    (researchState.status === "loading" ||
                      researchState.status === "error")
                      ? researchState.companyName === account.companyName
                      : researchState.status === "success" &&
                        researchState.research.companyName === account.companyName;
                  const isFindingContacts =
                    contactState.status === "loading" &&
                    contactState.companyName === account.companyName;
                  const showsContacts =
                    contactState.status === "loading" ||
                    contactState.status === "error"
                      ? contactState.companyName === account.companyName
                      : contactState.status === "success" &&
                        contactState.contacts.companyName === account.companyName;
                  const rowKey =
                    account.companyId ?? `${account.companyName}-${index}`;

                  return (
                    <Fragment key={rowKey}>
                      <tr>
                        <td className="px-4 py-3 font-medium text-slate-900">
                          {account.companyName ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {account.website ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {account.priority ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {account.researchStatus ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => researchAccount(account)}
                            disabled={
                              !account.companyName || researchState.status === "loading"
                            }
                            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            {isResearching ? "Researching..." : "Research"}
                          </button>
                          {researchState.status === "success" &&
                            researchState.research.companyName ===
                              account.companyName &&
                            researchState.cachedAt && (
                              <button
                                type="button"
                                // Bypasses the cache. Costs another Exa search plus an
                                // OpenRouter call, so it is a deliberate second click.
                                onClick={() => researchAccount(account, true)}
                                className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50"
                                title={`Cached ${new Date(researchState.cachedAt).toLocaleString()}. Re-running costs a fresh Exa search.`}
                              >
                                Re-research
                              </button>
                            )}
                          <button
                            type="button"
                            onClick={() => findContacts(account)}
                            disabled={
                              !account.companyName || contactState.status === "loading"
                            }
                            className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                          >
                            {isFindingContacts ? "Finding..." : "Find contacts"}
                          </button>
                          </div>
                        </td>
                      </tr>
                      {showsResearch && (
                        <tr>
                          <td colSpan={5} className="bg-slate-50 px-4 pb-6">
                            <ResearchReview
                              state={researchState}
                              companyId={account.companyId}
                            />
                          </td>
                        </tr>
                      )}
                      {showsContacts && (
                        <tr>
                          <td colSpan={5} className="bg-slate-50 px-4 pb-6">
                            <ContactReview
                              state={contactState}
                              companyId={account.companyId}
                              research={
                                researchState.status === "success" &&
                                researchState.research.companyName ===
                                  account.companyName
                                  ? researchState.research
                                  : null
                              }
                              sender={{ name: senderName, role: senderRole }}
                              misaEvents={misaEvents}
                              partnershipFormats={partnershipFormats}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function ContactReview({
  state,
  companyId,
  research,
  sender,
  misaEvents,
  partnershipFormats,
}: {
  state: ContactState;
  companyId: string | null;
  research: Research | null;
  sender: { name: string; role: string };
  misaEvents: string;
  partnershipFormats: string;
}) {
  const [emailStates, setEmailStates] = useState<Record<string, EmailState>>(
    {},
  );
  const [draftStates, setDraftStates] = useState<Record<string, DraftState>>({});
  const [noteStates, setNoteStates] = useState<Record<string, NoteState>>({});
  const [revealStates, setRevealStates] = useState<Record<string, RevealState>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [recorded, setRecorded] = useState<RecordedContact[]>([]);
  // Manual override for the sheet's SFU/MISA Alum flag. The providers miss real
  // alumni (Apify's education data is thin), so the user can correct it before saving.
  const [alumFlags, setAlumFlags] = useState<Record<string, boolean>>({});

  // What the sheet already records for this company, so a teammate sees "already
  // contacted" instead of approaching the same person twice. Best effort: a failed
  // read leaves the badges off rather than blocking the view.
  const recordedCompanyName =
    state.status === "success" ? state.contacts.companyName : null;
  useEffect(() => {
    setRecorded([]);
    if (!recordedCompanyName) return;
    let cancelled = false;
    fetchRecordedContacts(recordedCompanyName)
      .then((rows) => {
        if (!cancelled) setRecorded(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recordedCompanyName]);

  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <p className="mt-6 rounded-xl bg-indigo-50 px-4 py-4 text-sm text-indigo-800 ring-1 ring-indigo-200">
        Finding current employees at {state.companyName} in Greater Vancouver with
        Apify. This may take a few minutes.
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p className="mt-6 rounded-xl bg-red-50 px-4 py-4 text-sm text-red-700 ring-1 ring-red-200">
        {state.companyName}: {state.message}
      </p>
    );
  }

  const { contacts } = state;

  async function saveContact(args: {
    key: string;
    contact: {
      name: string;
      title: string;
      workEmail: string | null;
      linkedinUrl: string | null;
      isAlum: boolean;
    };
    outreachStatus: "Not started" | "Email sent" | "LinkedIn sent";
    channel: "" | "Email" | "LinkedIn";
  }) {
    if (saveStates[args.key]?.status === "saving") return;

    setSaveStates((current) => ({
      ...current,
      [args.key]: { status: "saving" },
    }));

    try {
      const detail = await saveContactToSheet({
        companyName: contacts.companyName,
        companyId,
        contact: args.contact,
        outreachStatus: args.outreachStatus,
        channel: args.channel,
        // Attribution belongs to whoever actually reached out; a merely saved
        // contact carries no name so filtering by person stays honest.
        reachedOutBy: args.outreachStatus === "Not started" ? "" : sender.name,
      });

      setSaveStates((current) => ({
        ...current,
        [args.key]: { status: "saved", detail },
      }));
      // Refresh so the "already contacted" badges reflect the row just written.
      fetchRecordedContacts(contacts.companyName)
        .then(setRecorded)
        .catch(() => {});
    } catch (error) {
      setSaveStates((current) => ({
        ...current,
        [args.key]: {
          status: "error",
          message: error instanceof Error ? error.message : "The save failed.",
        },
      }));
    }
  }

  /** Any verified SFU signal defaults the flag to Yes; the checkbox overrides either way. */
  function isAlum(target: DraftTarget) {
    return alumFlags[target.key] ?? target.sfuConnection !== null;
  }

  function contactFromTarget(target: DraftTarget) {
    return {
      name: target.name,
      title: target.title,
      workEmail: target.recipientEmail,
      linkedinUrl: target.linkedinUrl,
      isAlum: isAlum(target),
    };
  }

  async function enrichEmail(employee: ContactSearch["employees"][number]) {
    const profileKey = employee.linkedinUrl;
    if (emailStates[profileKey]?.status === "loading") return;

    setEmailStates((current) => ({
      ...current,
      [profileKey]: { status: "loading" },
    }));

    try {
      const response = await fetch("/api/enrich-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: employee.name,
          companyName: contacts.companyName,
          linkedinUrl: employee.linkedinUrl,
        }),
      });
      const data: unknown = await response.json();
      const result = parseEmailEnrichment(data);

      if (!response.ok || !result) {
        const error = objectRecord(data);
        throw new Error(
          typeof error?.error === "string"
            ? error.error
            : "Apollo email enrichment failed.",
        );
      }

      setEmailStates((current) => ({
        ...current,
        [profileKey]: { status: "success", result },
      }));
    } catch (error) {
      setEmailStates((current) => ({
        ...current,
        [profileKey]: {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Apollo email enrichment failed.",
        },
      }));
    }
  }

  async function draftEmail(target: DraftTarget) {
    const profileKey = target.key;
    if (draftStates[profileKey]?.status === "loading") return;

    setDraftStates((current) => ({
      ...current,
      [profileKey]: { status: "loading" },
    }));

    try {
      const response = await fetch("/api/draft-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "email",
          companyName: contacts.companyName,
          research,
          contact: {
            name: target.name,
            title: target.title,
            currentCompany: target.currentCompany,
            currentEmploymentEvidence: target.currentEmploymentEvidence,
            sfuConnection: target.sfuConnection,
            sfuEvidence: target.sfuEvidence,
          },
          sender,
          // Only ever a provider-verified address; never a guessed one.
          recipientEmail: target.recipientEmail,
          misaEvents,
          partnershipFormats,
        }),
      });
      const data: unknown = await response.json();
      const draft = parseOutreachDraft(data);

      if (!response.ok || !draft) {
        const error = objectRecord(data);
        throw new Error(
          typeof error?.error === "string"
            ? error.error
            : "The outreach draft failed.",
        );
      }

      setDraftStates((current) => ({
        ...current,
        [profileKey]: { status: "success", draft, edited: draft.body },
      }));
    } catch (error) {
      setDraftStates((current) => ({
        ...current,
        [profileKey]: {
          status: "error",
          message:
            error instanceof Error ? error.message : "The outreach draft failed.",
        },
      }));
    }
  }

  async function draftLinkedInNote(target: DraftTarget) {
    const profileKey = target.key;
    if (noteStates[profileKey]?.status === "loading") return;

    setNoteStates((current) => ({
      ...current,
      [profileKey]: { status: "loading" },
    }));

    try {
      const response = await fetch("/api/draft-outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "linkedin_note",
          companyName: contacts.companyName,
          research,
          contact: {
            name: target.name,
            title: target.title,
            currentCompany: target.currentCompany,
            currentEmploymentEvidence: target.currentEmploymentEvidence,
            sfuConnection: target.sfuConnection,
            sfuEvidence: target.sfuEvidence,
          },
          sender,
          profileUrl: target.linkedinUrl,
          misaEvents,
          partnershipFormats,
        }),
      });
      const data: unknown = await response.json();
      const draft = parseLinkedInNote(data);

      if (!response.ok || !draft) {
        const error = objectRecord(data);
        throw new Error(
          typeof error?.error === "string"
            ? error.error
            : "The LinkedIn note failed.",
        );
      }

      setNoteStates((current) => ({
        ...current,
        [profileKey]: { status: "success", draft, edited: draft.note },
      }));
    } catch (error) {
      setNoteStates((current) => ({
        ...current,
        [profileKey]: {
          status: "error",
          message:
            error instanceof Error ? error.message : "The LinkedIn note failed.",
        },
      }));
    }
  }

  function targetFromEmployee(
    employee: ContactSearch["employees"][number],
  ): DraftTarget {
    const emailState = emailStates[employee.linkedinUrl];

    return {
      key: employee.linkedinUrl,
      name: employee.name,
      title: employee.title,
      currentCompany: employee.currentCompany,
      currentEmploymentEvidence: employee.currentEmploymentEvidence,
      sfuConnection: employee.sfuConnection,
      sfuEvidence: employee.sfuEvidence,
      linkedinUrl: employee.linkedinUrl,
      recipientEmail:
        emailState?.status === "success"
          ? emailState.result.email?.value ?? null
          : null,
    };
  }

  /**
   * Apollo carries no education, so a revealed contact's SFU status is recovered by
   * matching their LinkedIn profile against what Apify already found for this account.
   */
  function targetFromRevealed(
    preview: ApolloPreview,
    revealed: RevealedContact,
  ): DraftTarget {
    const revealedProfile = revealed.linkedinUrl
      ? canonicalProfile(revealed.linkedinUrl)
      : null;
    const apifyMatch = revealedProfile
      ? contacts.employees.find(
          (employee) => canonicalProfile(employee.linkedinUrl) === revealedProfile,
        )
      : undefined;

    return {
      key: preview.apolloId,
      name: revealed.name ?? preview.maskedName,
      title: revealed.title ?? preview.title,
      // The sheet's name, not Apollo's brand string: the reveal already verified this
      // person against the account's domain, and "APPLY" would fail a name check.
      currentCompany: contacts.companyName,
      currentEmploymentEvidence: `Apollo verified this contact at ${revealed.organizationDomain ?? contacts.companyName}.`,
      sfuConnection: apifyMatch?.sfuConnection ?? null,
      sfuEvidence: apifyMatch?.sfuEvidence ?? null,
      linkedinUrl: revealed.linkedinUrl,
      recipientEmail: revealed.email?.value ?? null,
    };
  }

  async function revealContact(preview: ApolloPreview) {
    if (revealStates[preview.apolloId]?.status === "loading") return;

    setRevealStates((current) => ({
      ...current,
      [preview.apolloId]: { status: "loading" },
    }));

    try {
      const response = await fetch("/api/reveal-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apolloId: preview.apolloId,
          companyDomain: contacts.companyDomain ?? null,
        }),
      });
      const data: unknown = await response.json();
      const payload = objectRecord(data);
      const contact = objectRecord(payload?.contact) as RevealedContact | null;

      if (!response.ok) {
        throw new Error(
          typeof payload?.error === "string" ? payload.error : "The reveal failed.",
        );
      }

      setRevealStates((current) => ({
        ...current,
        [preview.apolloId]: contact
          ? {
              status: "success",
              contact,
              limitations: stringList(payload?.limitations),
            }
          : {
              status: "error",
              message:
                stringList(payload?.limitations)[0] ??
                "Apollo could not reveal this contact.",
            },
      }));

      // A reveal costs a credit, so the result is recorded immediately as
      // "Not started" — nobody should have to pay for it a second time.
      if (contact) {
        const target = targetFromRevealed(preview, contact);
        void saveContact({
          key: target.key,
          contact: contactFromTarget(target),
          outreachStatus: "Not started",
          channel: "",
        });
      }
    } catch (error) {
      setRevealStates((current) => ({
        ...current,
        [preview.apolloId]: {
          status: "error",
          message: error instanceof Error ? error.message : "The reveal failed.",
        },
      }));
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">
        Contact review · not saved
      </p>
      <h3 className="mt-2 text-lg font-semibold">
        Employees at {contacts.companyName}, Greater Vancouver first
      </h3>
      <p className="mt-2 text-xs text-slate-600">
        Pick one contact per account and enrich only that one. Apollo charges 1
        credit whenever it returns email or demographic data, including when the
        email is unverified and gets discarded here. Lookups that find nothing are
        free.
      </p>

      {recorded.some(wasContacted) && (
        <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          Someone on the team has already reached out at {contacts.companyName}:{" "}
          {recorded
            .filter(wasContacted)
            .map(
              (row) =>
                `${row.name} (${row.outreachStatus}${row.reachedOutBy ? ` by ${row.reachedOutBy}` : ""}${row.dateReachedOut ? `, ${row.dateReachedOut}` : ""})`,
            )
            .join("; ")}
          . Check with them before contacting this company again.
        </p>
      )}

      {contacts.employees.length > 0 ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {contacts.employees.map((employee) => {
            const emailState: EmailState = emailStates[employee.linkedinUrl] ?? {
              status: "idle",
            };
            const draftState: DraftState = draftStates[employee.linkedinUrl] ?? {
              status: "idle",
            };
            const noteState: NoteState = noteStates[employee.linkedinUrl] ?? {
              status: "idle",
            };
            const saveState: SaveState = saveStates[employee.linkedinUrl] ?? {
              status: "idle",
            };
            const recordedMatch = findRecordedMatch(recorded, employee);

            return (
              <article
                key={employee.linkedinUrl}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
              <a
                href={employee.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-2 hover:text-indigo-900"
              >
                {employee.name}
              </a>
              {employee.sfuConnection && (
                <span className="ml-2 inline-flex rounded-full bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 ring-1 ring-red-200">
                  {employee.sfuConnection === "alumni"
                    ? "SFU alumnus"
                    : "SFU education"}
                </span>
              )}
              {employee.sources?.length > 0 && (
                <span className="ml-2 inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                  {employee.sources.join(" + ")}
                </span>
              )}
              <RecordedBadge record={recordedMatch} />
              <p className="mt-1 text-sm font-medium text-slate-800">
                {employee.title}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                {employee.currentCompany}
                {employee.location ? ` · ${employee.location}` : ""}
              </p>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                {employee.currentEmploymentEvidence} Accessed{" "}
                {new Date(employee.accessedAt).toLocaleDateString()}.
              </p>
              {employee.sfuEvidence && (
                <p className="mt-2 text-xs leading-5 text-red-700">
                  {employee.sfuEvidence}
                </p>
              )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => enrichEmail(employee)}
                    disabled={emailState.status === "loading"}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {emailState.status === "loading"
                      ? "Enriching..."
                      : "Enrich email (1 credit)"}
                  </button>
                  <button
                    type="button"
                    onClick={() => draftEmail(targetFromEmployee(employee))}
                    disabled={draftState.status === "loading" || !research}
                    title={
                      research
                        ? undefined
                        : "Research this account first so the draft can cite evidence."
                    }
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {draftState.status === "loading"
                      ? "Drafting..."
                      : "Draft email"}
                  </button>
                  <button
                    type="button"
                    onClick={() => draftLinkedInNote(targetFromEmployee(employee))}
                    disabled={noteState.status === "loading" || !research}
                    title={
                      research
                        ? undefined
                        : "Research this account first so the note can cite evidence."
                    }
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {noteState.status === "loading"
                      ? "Drafting..."
                      : "Draft LinkedIn note"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      saveContact({
                        key: employee.linkedinUrl,
                        contact: contactFromTarget(targetFromEmployee(employee)),
                        outreachStatus: "Not started",
                        channel: "",
                      })
                    }
                    disabled={saveState.status === "saving"}
                    className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {saveState.status === "saving"
                      ? "Saving..."
                      : "Save to sheet"}
                  </button>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={
                        alumFlags[employee.linkedinUrl] ??
                        employee.sfuConnection !== null
                      }
                      onChange={(event) =>
                        setAlumFlags((current) => ({
                          ...current,
                          [employee.linkedinUrl]: event.target.checked,
                        }))
                      }
                      className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                    />
                    SFU/MISA alum
                  </label>
                </div>

                <SaveStatusNote state={saveState} />

                {!research && (
                  <p className="mt-2 text-xs text-slate-500">
                    Research this account first so the draft can cite evidence.
                  </p>
                )}

                {emailState.status === "success" && emailState.result.email && (
                  <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
                    {emailState.result.email.value} · Verified by Apollo
                  </p>
                )}

                {emailState.status === "success" && !emailState.result.email && (
                  <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                    {emailState.result.limitations.join(" ")}
                  </p>
                )}

                {emailState.status === "error" && (
                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                    {emailState.message}
                  </p>
                )}

                {draftState.status === "error" && (
                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                    {draftState.message}
                  </p>
                )}

                {noteState.status === "error" && (
                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                    {noteState.message}
                  </p>
                )}

                {noteState.status === "success" && (
                  <div className="mt-3 rounded-xl border border-sky-300 bg-sky-50/60 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-sky-200 px-2 py-1 text-xs font-semibold text-sky-900">
                        LinkedIn note · copy manually
                      </span>
                      {noteState.draft.personalized ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          Personalized · cites{" "}
                          {noteState.draft.sourceIds.join(", ")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                          General introduction
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-semibold ${
                          noteState.edited.length > LINKEDIN_NOTE_LIMIT
                            ? "bg-red-100 text-red-800"
                            : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {noteState.edited.length}/{LINKEDIN_NOTE_LIMIT}
                      </span>
                    </div>

                    {noteState.draft.violations.length > 0 && (
                      <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-300">
                        <p className="font-semibold">
                          Unsupported claims detected. Fix these before sending:
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-5">
                          {noteState.draft.violations.map((violation) => (
                            <li key={violation}>{violation}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <textarea
                      value={noteState.edited}
                      onChange={(event) =>
                        setNoteStates((current) => {
                          const existing = current[employee.linkedinUrl];
                          return existing?.status === "success"
                            ? {
                                ...current,
                                [employee.linkedinUrl]: {
                                  ...existing,
                                  edited: event.target.value,
                                },
                              }
                            : current;
                        })
                      }
                      rows={5}
                      className="mt-2 w-full rounded-lg border border-slate-300 bg-white p-3 text-xs leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                    />

                    {noteState.edited.length > LINKEDIN_NOTE_LIMIT && (
                      <p className="mt-1 text-xs font-medium text-red-700">
                        LinkedIn will reject a connection note over{" "}
                        {LINKEDIN_NOTE_LIMIT} characters. Trim{" "}
                        {noteState.edited.length - LINKEDIN_NOTE_LIMIT} more.
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          navigator.clipboard.writeText(noteState.edited)
                        }
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                      >
                        Copy note
                      </button>
                      <a
                        href={employee.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-slate-50"
                      >
                        Open profile
                      </a>
                      <button
                        type="button"
                        onClick={() =>
                          saveContact({
                            key: employee.linkedinUrl,
                            contact: contactFromTarget(
                              targetFromEmployee(employee),
                            ),
                            outreachStatus: "LinkedIn sent",
                            channel: "LinkedIn",
                          })
                        }
                        disabled={saveState.status === "saving"}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        {saveState.status === "saving"
                          ? "Saving..."
                          : "Mark LinkedIn sent"}
                      </button>
                    </div>

                    {noteState.draft.limitations.length > 0 && (
                      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
                        {noteState.draft.limitations.map((limitation) => (
                          <li key={limitation}>{limitation}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {draftState.status === "success" && (
                  <div className="mt-3 rounded-xl border border-slate-300 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">
                        Draft only · not sent
                      </span>
                      {draftState.draft.personalized ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          Personalized · cites{" "}
                          {draftState.draft.whyYouSourceIds.join(", ")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                          Template only
                        </span>
                      )}
                    </div>

                    {draftState.draft.violations.length > 0 && (
                      <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-300">
                        <p className="font-semibold">
                          Unsupported claims detected. Fix these before using the
                          draft:
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-5">
                          {draftState.draft.violations.map((violation) => (
                            <li key={violation}>{violation}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <p className="mt-3 text-xs font-medium text-slate-700">
                      To: {draftState.draft.recipientEmail ?? "(no verified address)"}
                    </p>
                    <p className="mt-1 text-xs font-medium text-slate-700">
                      Subject: {draftState.draft.subject}
                    </p>

                    <textarea
                      value={draftState.edited}
                      onChange={(event) =>
                        setDraftStates((current) => {
                          const existing = current[employee.linkedinUrl];
                          return existing?.status === "success"
                            ? {
                                ...current,
                                [employee.linkedinUrl]: {
                                  ...existing,
                                  edited: event.target.value,
                                },
                              }
                            : current;
                        })
                      }
                      rows={18}
                      className="mt-2 w-full rounded-lg border border-slate-300 bg-white p-3 text-xs leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                    />

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          navigator.clipboard.writeText(
                            `Subject: ${draftState.draft.subject}\n\n${draftState.edited}`,
                          )
                        }
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                      >
                        Copy subject and body
                      </button>
                      <GmailComposeLink
                        to={draftState.draft.recipientEmail}
                        subject={draftState.draft.subject}
                        body={draftState.edited}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          saveContact({
                            key: employee.linkedinUrl,
                            contact: contactFromTarget(
                              targetFromEmployee(employee),
                            ),
                            outreachStatus: "Email sent",
                            channel: "Email",
                          })
                        }
                        disabled={saveState.status === "saving"}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        {saveState.status === "saving"
                          ? "Saving..."
                          : "Mark email sent"}
                      </button>
                    </div>

                    {draftState.draft.limitations.length > 0 && (
                      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
                        {draftState.draft.limitations.map((limitation) => (
                          <li key={limitation}>{limitation}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          No contacts survived verification. See the notes below for what the
          search returned and why it was set aside.
        </p>
      )}

      {(contacts.previews?.length ?? 0) > 0 && (
        <div className="mt-6">
          <h4 className="font-semibold">
            Apollo found {contacts.previews!.length} people at{" "}
            {contacts.companyDomain ?? contacts.companyName}
          </h4>
          <p className="mt-1 text-xs text-slate-600">
            Apollo hides surnames, emails and profile links until you reveal someone.
            Roles you asked to prioritise are listed first. Revealing one costs 1
            credit; the rest stay free.
          </p>
          <div className="mt-3 grid gap-2">
            {contacts.previews!.map((preview) => {
              const revealState: RevealState =
                revealStates[preview.apolloId] ?? { status: "idle" };
              const revealed =
                revealState.status === "success" ? revealState.contact : null;

              return (
                <article
                  key={preview.apolloId}
                  className="rounded-xl border border-slate-200 bg-white p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">
                      {revealed?.name ?? preview.maskedName}
                    </span>
                    {preview.isTargetRole && (
                      <span className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
                        Priority role
                      </span>
                    )}
                    {!preview.hasEmail && (
                      <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                        No email on file
                      </span>
                    )}
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                      Apollo
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-800">
                    {revealed?.title ?? preview.title}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {revealed?.organizationName ?? preview.organizationName ?? ""}
                    {revealed?.location ? ` · ${revealed.location}` : ""}
                  </p>

                  {revealed ? (
                    <div className="mt-2">
                      {revealed.email ? (
                        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
                          {revealed.email.value} · Verified by Apollo
                        </p>
                      ) : (
                        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                          {revealState.status === "success" &&
                          revealState.limitations.length > 0
                            ? revealState.limitations.join(" ")
                            : "No verified work email was returned."}
                        </p>
                      )}
                      {revealed.linkedinUrl && (
                        <a
                          href={revealed.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-block text-xs font-semibold text-indigo-700 underline"
                        >
                          Open LinkedIn profile
                        </a>
                      )}
                      {(() => {
                        const target = targetFromRevealed(preview, revealed);
                        const draftState: DraftState =
                          draftStates[target.key] ?? { status: "idle" };
                        const noteState: NoteState =
                          noteStates[target.key] ?? { status: "idle" };
                        const saveState: SaveState =
                          saveStates[target.key] ?? { status: "idle" };
                        const recordedMatch = findRecordedMatch(recorded, {
                          linkedinUrl: target.linkedinUrl,
                          name: target.name,
                        });

                        return (
                          <>
                            <div className="mt-2">
                              <RecordedBadge record={recordedMatch} />
                            </div>
                            <SaveStatusNote state={saveState} />
                            <label className="mt-2 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                              <input
                                type="checkbox"
                                checked={isAlum(target)}
                                onChange={(event) =>
                                  setAlumFlags((current) => ({
                                    ...current,
                                    [target.key]: event.target.checked,
                                  }))
                                }
                                className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                              />
                              SFU/MISA alum · saved with this contact
                            </label>
                            {target.sfuConnection && (
                              <p className="mt-2 text-xs font-medium text-red-700">
                                Cross-referenced with Apify: SFU{" "}
                                {target.sfuConnection === "alumni"
                                  ? "alumnus"
                                  : "education"}
                                . {target.sfuEvidence}
                              </p>
                            )}

                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => draftEmail(target)}
                                disabled={draftState.status === "loading" || !research}
                                title={
                                  research
                                    ? undefined
                                    : "Research this account first so the draft can cite evidence."
                                }
                                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                              >
                                {draftState.status === "loading"
                                  ? "Drafting..."
                                  : "Draft email"}
                              </button>
                              <button
                                type="button"
                                onClick={() => draftLinkedInNote(target)}
                                disabled={noteState.status === "loading" || !research}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                              >
                                {noteState.status === "loading"
                                  ? "Drafting..."
                                  : "Draft LinkedIn note"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  saveContact({
                                    key: target.key,
                                    contact: contactFromTarget(target),
                                    outreachStatus: "Not started",
                                    channel: "",
                                  })
                                }
                                disabled={saveState.status === "saving"}
                                className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-400"
                              >
                                {saveState.status === "saving"
                                  ? "Saving..."
                                  : "Save to sheet"}
                              </button>
                            </div>

                            {draftState.status === "error" && (
                              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                                {draftState.message}
                              </p>
                            )}
                            {noteState.status === "error" && (
                              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                                {noteState.message}
                              </p>
                            )}

                            {draftState.status === "success" && (
                              <div className="mt-3 rounded-xl border border-slate-300 bg-slate-50 p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">
                                    Email draft · not sent
                                  </span>
                                  {draftState.draft.violations.length > 0 && (
                                    <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800">
                                      Unsupported claims — review before sending
                                    </span>
                                  )}
                                </div>
                                <p className="mt-2 text-xs font-medium text-slate-700">
                                  To:{" "}
                                  {draftState.draft.recipientEmail ??
                                    "(no verified address)"}
                                </p>
                                <p className="mt-1 text-xs font-medium text-slate-700">
                                  Subject: {draftState.draft.subject}
                                </p>
                                <textarea
                                  value={draftState.edited}
                                  onChange={(event) =>
                                    setDraftStates((current) => {
                                      const existing = current[target.key];
                                      return existing?.status === "success"
                                        ? {
                                            ...current,
                                            [target.key]: {
                                              ...existing,
                                              edited: event.target.value,
                                            },
                                          }
                                        : current;
                                    })
                                  }
                                  rows={14}
                                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white p-3 text-xs leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                                />
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      navigator.clipboard.writeText(
                                        `Subject: ${draftState.draft.subject}\n\n${draftState.edited}`,
                                      )
                                    }
                                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                                  >
                                    Copy subject and body
                                  </button>
                                  <GmailComposeLink
                                    to={draftState.draft.recipientEmail}
                                    subject={draftState.draft.subject}
                                    body={draftState.edited}
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      saveContact({
                                        key: target.key,
                                        contact: contactFromTarget(target),
                                        outreachStatus: "Email sent",
                                        channel: "Email",
                                      })
                                    }
                                    disabled={saveState.status === "saving"}
                                    className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                                  >
                                    {saveState.status === "saving"
                                      ? "Saving..."
                                      : "Mark email sent"}
                                  </button>
                                </div>
                                {draftState.draft.limitations.length > 0 && (
                                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
                                    {draftState.draft.limitations.map((limitation) => (
                                      <li key={limitation}>{limitation}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}

                            {noteState.status === "success" && (
                              <div className="mt-3 rounded-xl border border-sky-300 bg-sky-50/60 p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full bg-sky-200 px-2 py-1 text-xs font-semibold text-sky-900">
                                    LinkedIn note · copy manually
                                  </span>
                                  <span
                                    className={
                                      noteState.edited.length > LINKEDIN_NOTE_LIMIT
                                        ? "rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800"
                                        : "rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700"
                                    }
                                  >
                                    {noteState.edited.length}/{LINKEDIN_NOTE_LIMIT}
                                  </span>
                                </div>
                                <textarea
                                  value={noteState.edited}
                                  onChange={(event) =>
                                    setNoteStates((current) => {
                                      const existing = current[target.key];
                                      return existing?.status === "success"
                                        ? {
                                            ...current,
                                            [target.key]: {
                                              ...existing,
                                              edited: event.target.value,
                                            },
                                          }
                                        : current;
                                    })
                                  }
                                  rows={5}
                                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white p-3 text-xs leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                                />
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      navigator.clipboard.writeText(noteState.edited)
                                    }
                                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                                  >
                                    Copy note
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      saveContact({
                                        key: target.key,
                                        contact: contactFromTarget(target),
                                        outreachStatus: "LinkedIn sent",
                                        channel: "LinkedIn",
                                      })
                                    }
                                    disabled={saveState.status === "saving"}
                                    className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                                  >
                                    {saveState.status === "saving"
                                      ? "Saving..."
                                      : "Mark LinkedIn sent"}
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => revealContact(preview)}
                      disabled={revealState.status === "loading"}
                      className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                    >
                      {revealState.status === "loading"
                        ? "Revealing..."
                        : "Reveal name and email (1 credit)"}
                    </button>
                  )}

                  {revealState.status === "error" && (
                    <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
                      {revealState.message}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}

      {contacts.limitations.length > 0 && (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-slate-600">
          {contacts.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ResearchReview({
  state,
  companyId,
}: {
  state: ResearchState;
  companyId: string | null;
}) {
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });

  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <p className="mt-6 rounded-xl bg-indigo-50 px-4 py-4 text-sm text-indigo-800 ring-1 ring-indigo-200">
        Researching {state.companyName}. Exa is finding sources and OpenRouter is
        preparing a grounded review. If synthesis needs a retry, this can take up
        to three minutes.
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p className="mt-6 rounded-xl bg-red-50 px-4 py-4 text-sm text-red-700 ring-1 ring-red-200">
        {state.companyName}: {state.message}
      </p>
    );
  }

  const research = state.research;

  async function saveResearch() {
    if (saveState.status === "saving") return;
    setSaveState({ status: "saving" });

    try {
      const detail = await saveResearchToSheet({
        companyName: research.companyName,
        companyId,
        // Fills the sheet's Website cell when it is blank; a value the user typed
        // there is never overwritten.
        inferredWebsite: inferCompanyDomain(
          research.sources.map((source) => source.url),
          research.companyName,
        ),
        research: {
          alignmentSummary: research.alignmentSummary,
          companyOverview: research.companyOverview,
          fitScore: research.fitScore,
          confidenceScore: research.confidenceScore,
        },
      });
      setSaveState({ status: "saved", detail });
    } catch (error) {
      setSaveState({
        status: "error",
        message: error instanceof Error ? error.message : "The save failed.",
      });
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">
            {saveState.status === "saved"
              ? "Saved to the Companies tab"
              : "Review only · not saved"}
          </p>
          <h3 className="mt-2 text-xl font-semibold">{research.companyName}</h3>
        </div>
        <button
          type="button"
          onClick={saveResearch}
          disabled={saveState.status === "saving"}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          title="Writes the research status, scores and date to the Companies tab. The prose stays here and in the cache."
        >
          {saveState.status === "saving" ? "Saving..." : "Save research to sheet"}
        </button>
      </div>
      <SaveStatusNote state={saveState} />

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <ScoreCard label="Fit score" score={research.fitScore} />
        <ScoreCard
          label="Evidence confidence"
          score={research.confidenceScore}
          detail={research.confidenceBasis}
        />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <ResearchSection
          title="What the company does"
          text={research.companyOverview}
          sourceIds={research.companyOverviewSourceIds}
        />
        <ResearchSection
          title="MISA alignment"
          text={research.alignmentSummary}
          sourceIds={research.alignmentSourceIds}
        />
        <ResearchSection
          title="Recommended pitch angle"
          text={research.pitchAngle}
          sourceIds={research.pitchSourceIds}
        />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <ResearchList
          title="Roles the company commonly hires for"
          empty="No hiring patterns were adequately supported by the sources."
          items={research.commonRoles.map((item) => ({
            title: item.role,
            detail: item.evidence,
            sourceIds: item.sourceIds,
          }))}
        />
        <ResearchList
          title="Partnership opportunities"
          empty="No adequately supported partnership opportunity was found."
          items={research.partnershipOpportunities.map((item) => ({
            title: item.title,
            detail: item.rationale,
            sourceIds: item.sourceIds,
          }))}
        />
      </div>

      <div className="mt-6">
        <h4 className="font-semibold">Evidence-backed claims</h4>
        {research.claims.length ? (
          <div className="mt-3 space-y-3">
            {research.claims.map((claim, index) => (
              <article
                key={`${claim.claim}-${index}`}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <p className="font-medium text-slate-900">{claim.claim}</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {claim.evidence}
                </p>
                <p className="mt-2 text-xs font-semibold text-indigo-600">
                  Sources: {claim.sourceIds.join(", ")}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">No supported claims found.</p>
        )}
      </div>

      {research.limitations.length > 0 && (
        <div className="mt-6 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
          <h4 className="font-semibold text-amber-900">Limitations</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900/80">
            {research.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <h4 className="font-semibold">Sources found ({research.sources.length})</h4>
        <div className="mt-3 grid gap-3">
          {research.sources.map((source) => (
            <article
              key={source.id}
              className="rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                  {source.id}
                </span>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-semibold ${
                    source.searchProvider === "Exa"
                      ? "bg-sky-50 text-sky-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {source.searchProvider}
                </span>
                {source.isOfficial && (
                  <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                    Official domain
                  </span>
                )}
              </div>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block font-medium text-indigo-700 underline decoration-indigo-200 underline-offset-2 hover:text-indigo-900"
              >
                {source.title ?? source.url}
              </a>
              <p className="mt-1 text-xs text-slate-500">
                Published: {source.publishedDate ?? "Unknown"}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScoreCard({
  label,
  score,
  detail,
}: {
  label: string;
  score: number;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-950">{score}/100</p>
      {detail && <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>}
    </div>
  );
}

function ResearchSection({
  title,
  text,
  sourceIds,
}: {
  title: string;
  text: string | null;
  sourceIds: string[];
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        {text ?? "No adequately supported conclusion."}
      </p>
      {sourceIds.length > 0 && (
        <p className="mt-3 text-xs font-semibold text-indigo-600">
          Sources: {sourceIds.join(", ")}
        </p>
      )}
    </div>
  );
}

function ResearchList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ title: string; detail: string; sourceIds: string[] }>;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h4 className="font-semibold">{title}</h4>
      {items.length ? (
        <div className="mt-3 space-y-3">
          {items.map((item, index) => (
            <article
              key={`${item.title}-${index}`}
              className="rounded-lg bg-slate-50 p-3"
            >
              <p className="font-medium text-slate-900">{item.title}</p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {item.detail}
              </p>
              <p className="mt-2 text-xs font-semibold text-indigo-600">
                Sources: {item.sourceIds.join(", ")}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-600">{empty}</p>
      )}
    </div>
  );
}

function SaveStatusNote({ state }: { state: SaveState }) {
  if (state.status === "saved") {
    return (
      <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
        {state.detail}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
        Save failed: {state.message}
      </p>
    );
  }

  return null;
}

/**
 * What the sheet already records for this person. The amber badge is the load-bearing
 * one: it is what stops two teammates emailing the same contact.
 */
function RecordedBadge({ record }: { record: RecordedContact | null }) {
  if (!record) return null;

  if (wasContacted(record)) {
    return (
      <span className="ml-2 inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300">
        Already contacted · {record.outreachStatus}
        {record.reachedOutBy ? ` by ${record.reachedOutBy}` : ""}
        {record.dateReachedOut ? ` · ${record.dateReachedOut}` : ""}
      </span>
    );
  }

  return (
    <span className="ml-2 inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
      In sheet · Not started
    </span>
  );
}

function GmailComposeLink({
  to,
  subject,
  body,
}: {
  to: string | null;
  subject: string;
  body: string;
}) {
  const compose = buildGmailComposeLink({
    sendAs: MISA_MAILBOX,
    to,
    subject,
    body,
  });

  return (
    <>
      <a
        href={compose.url}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50"
        title={`Opens a prefilled draft in Gmail as ${MISA_MAILBOX}. Nothing is sent until you press Send there.`}
      >
        Open in Gmail
      </a>
      {compose.bodyOmitted && (
        <span className="text-xs text-amber-800">
          The body is too long to prefill — copy it and paste into Gmail.
        </span>
      )}
    </>
  );
}
