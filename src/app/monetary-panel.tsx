"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { CompanyResearch } from "@/lib/company-research";
import { getEmptyMonetaryHistory, getMonetaryHistory, monetaryContactKey, subscribeMonetaryHistory, updateMonetaryHistory } from "@/lib/monetary-browser-history";
import { compareMonetaryFit, groupMonetaryContacts, hasVerifiedWorkEmail, MONETARY_CONTACT_LIMIT, type HunterSearchCounts, type MonetaryContact, type MonetaryEmailSource, type MonetarySearchResult, type MonetaryWebsite, type VerifiedMonetaryContact } from "@/lib/monetary-waterfall";
import { MonetaryDraft, researchMonetaryCompany, type MonetaryDraftTarget } from "./monetary-draft";

type Account = { companyId: string | null; companyName: string | null; website: string | null };
const STATUS = {
  skipped: "Skipped", quota: "Limit reached", empty: "No usable contact",
  profiles: "Profiles only", found: "Work email found", unavailable: "Unavailable",
};
const EMPTY_RESULT: MonetarySearchResult = { contacts: [], profileOnly: [], additionalContacts: [], attempts: [] };
const companyKeyFor = ({ companyId, companyName }: Account) => JSON.stringify([companyId, companyName]);
const HUNTER_REASONS: Record<Exclude<keyof HunterSearchCounts, "returned">, string> = {
  noNamedPerson: "Shared mailbox or no full individual name",
  outsideIcp: "Title outside the target roles or missing",
  emailMissing: "No email supplied",
  wrongOrInvalidAddress: "Invalid address or wrong company domain",
  catchAll: "Catch-all email",
  unverified: "Email not verified by Hunter",
  outsideCompanyScope: "Outside the selected organization",
};

function HunterBreakdown({ counts }: { counts: HunterSearchCounts }) {
  const reasons = (Object.keys(HUNTER_REASONS) as Array<keyof typeof HUNTER_REASONS>)
    .filter((reason) => counts[reason] > 0);
  return (
    <div className="mt-1 rounded-lg border border-slate-200 p-2">
      <p className="font-medium">Hunter returned {counts.returned} {counts.returned === 1 ? "result" : "results"}.</p>
      <p>{counts.returned - counts.noNamedPerson - counts.outsideCompanyScope - counts.outsideIcp} matched target roles.</p>
      {reasons.length > 0 && (
        <>
          <p>Why results didn’t qualify. One result can have more than one reason.</p>
          <ul className="ml-4 list-disc">
            {reasons.map((reason) => <li key={reason}>{HUNTER_REASONS[reason]}: {counts[reason]}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function ContactCard({ contact, finder, saved, onSave, onDraft, outsideCount }: {
  contact: MonetaryContact;
  finder?: { disabled: boolean; pending: boolean; message?: string; lookup: () => void };
  saved?: boolean;
  onSave?: () => void;
  onDraft?: (contact: VerifiedMonetaryContact) => void;
  outsideCount?: boolean;
}) {
  const emailSource = contact.emailSource ?? (contact.provider === "Hunter" ? "Hunter" : undefined);
  return (
    <article className="rounded-xl border border-slate-200 p-3 text-sm">
      <h3 className="font-semibold">{contact.name}{contact.title && ` · ${contact.title}`}</h3>
      {contact.location && (
        <p>{contact.location} · {contact.provider}{contact.sfuAlumni ? " · SFU alum" : ""}</p>
      )}
      <p className="break-all">
        {contact.workEmail ?? "No verified work email"}
        {contact.workEmail && emailSource && ` · Verified by ${emailSource}`}
      </p>
      {contact.icpMatch === false && <p className="text-slate-600">Outside target roles · not counted</p>}
      {outsideCount && <p className="text-slate-600">Verified email · outside the five-contact count</p>}
      {contact.linkedinUrl && <a className="text-indigo-700 underline" href={contact.linkedinUrl}
        target="_blank" rel="noopener noreferrer">LinkedIn source</a>}
      {contact.sourceUrl && <a className="text-indigo-700 underline" href={contact.sourceUrl}
        target="_blank" rel="noopener noreferrer">Official directory source</a>}
      {onSave && <button type="button" onClick={onSave} aria-pressed={saved}
        aria-label={saved ? `Remove saved contact ${contact.name}` : `Save contact ${contact.name}`}
        className="mt-2 block rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-slate-800">
        {saved ? "Remove from saved" : "Save contact"}
      </button>}
      {onDraft && hasVerifiedWorkEmail(contact) && (
        <button type="button" onClick={() => onDraft(contact)}
          className="mt-2 block rounded-lg border border-indigo-700 px-3 py-1.5 font-semibold text-indigo-700">
          Draft personalized email
        </button>
      )}
      {finder && (
        <div className="mt-2 space-y-1">
          <button type="button" onClick={finder.lookup} disabled={finder.disabled}
            className="rounded-lg border border-indigo-700 px-3 py-1.5 font-semibold text-indigo-700 disabled:opacity-50">
            {finder.pending ? "Checking work email…" : "Find verified work email"}
          </button>
          {finder.message && <p role="status">{finder.message}</p>}
        </div>
      )}
    </article>
  );
}

export function MonetaryPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountError, setAccountError] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const history = useSyncExternalStore(subscribeMonetaryHistory, getMonetaryHistory, getEmptyMonetaryHistory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [finding, setFinding] = useState<MonetaryContact | null>(null);
  const [emailMessages, setEmailMessages] = useState(new Map<MonetaryContact, string>());
  const [fullName, setFullName] = useState("");
  const [manualMessage, setManualMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [hideWithEmail, setHideWithEmail] = useState(false);
  const [draftTarget, setDraftTarget] = useState<MonetaryDraftTarget | null>(null);
  const draftDialog = useRef<HTMLDialogElement>(null);
  const draftTitleId = useId();
  const researchByCompany = useRef(new Map<string, Promise<CompanyResearch>>());

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/accounts", { cache: "no-store", signal: controller.signal });
        const data = (await response.json()) as { accounts?: Account[] };
        if (!response.ok || !Array.isArray(data.accounts)) throw new Error();
        if (!controller.signal.aborted) setAccounts(data.accounts);
      } catch {
        if (!controller.signal.aborted) setAccountError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const rows = (accounts ?? []).map((account, index) => ({ account, index }))
    .filter(({ account }) => account.companyName?.toLowerCase().includes(query.trim().toLowerCase()));
  const company = selected === null ? undefined : accounts?.[selected];
  const companyKey = company ? companyKeyFor(company) : "";
  const companyHistory = history.companies[companyKey];
  const result = companyHistory?.result;
  const verifiedCount = result?.contacts.length ?? 0;
  const lookupPending = busy || finding !== null;
  const hunter = result?.attempts.find(({ provider }) => provider === "Hunter");
  const candidates = hunter?.websiteCandidates ?? [];
  const savedContacts = Object.values(history.saved);
  const rankedPeople = result
    ? [...result.contacts, ...result.profileOnly, ...result.additionalContacts].sort(compareMonetaryFit) : [];
  const visiblePeople = hideWithEmail ? rankedPeople.filter((person) => !hasVerifiedWorkEmail(person)) : rankedPeople;
  const targetPeople = visiblePeople.filter(({ icpMatch }) => icpMatch !== false);
  const otherPeople = visiblePeople.filter(({ icpMatch }) => icpMatch === false);
  const peopleCount = rankedPeople.length;
  const hiddenCount = peopleCount - visiblePeople.length;

  function openDraft(key: string, contact: VerifiedMonetaryContact, account?: Account) {
    const entry = history.companies[key];
    const website = entry?.website ?? entry?.result?.attempts.find(({ provider }) => provider === "Hunter")?.website;
    setDraftTarget({
      companyId: account?.companyId ?? null,
      companyName: account?.companyName ?? contact.company,
      website: website ? `https://${website.domain}` : account?.website ?? null,
      contact,
    });
    draftDialog.current?.showModal();
  }

  function selectCompany(value: number) {
    if (selected === value) return;
    setSelected(value);
    setError("");
    setFullName("");
    setManualMessage("");
    setEmailMessages(new Map());
  }

  function saveContact(key: string, contact: MonetaryContact) {
    setStorageWarning(!updateMonetaryHistory((current) => {
      const contactKey = monetaryContactKey(key, contact);
      const saved = { ...current.saved };
      if (saved[contactKey]) delete saved[contactKey];
      else saved[contactKey] = { companyKey: key, contact };
      return { ...current, saved };
    }));
  }

  function forgetWebsite() {
    setStorageWarning(!updateMonetaryHistory((current) => {
      const companies = { ...current.companies };
      delete companies[companyKey];
      return { ...current, companies };
    }));
    setError("");
  }

  function saveResult(key: string, incoming: MonetarySearchResult, verified?: MonetaryContact) {
    setStorageWarning(!updateMonetaryHistory((current) => {
      const previous = current.companies[key];
      const saved = { ...current.saved };
      for (const contact of verified ? [verified] : incoming.contacts) {
        const contactKey = monetaryContactKey(key, contact);
        if (saved[contactKey]) saved[contactKey] = { companyKey: key, contact };
      }
      return { ...current, saved, companies: { ...current.companies, [key]: { ...previous, result: incoming } } };
    }));
  }

  async function search(index: number, choice?: MonetaryWebsite) {
    const account = accounts?.[index];
    if (lookupPending || !account?.companyName) return;
    selectCompany(index);
    const key = companyKeyFor(account);
    const website = choice ?? getMonetaryHistory().companies[key]?.website;
    setBusy(true);
    setEmailMessages(new Map());
    setError("");
    try {
      const response = await fetch("/api/search-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: account.companyId, companyName: account.companyName, website }),
      });
      const data = (await response.json()) as Partial<MonetarySearchResult> & { error?: string };
      if (!response.ok || !Array.isArray(data.contacts) || !Array.isArray(data.profileOnly) ||
          !Array.isArray(data.additionalContacts) || !Array.isArray(data.attempts)) {
        throw new Error(data.error ?? "Could not look up contacts.");
      }
      const incoming = data as MonetarySearchResult;
      setStorageWarning(!updateMonetaryHistory((history) => {
        const previous = history.companies[key];
        const incomingDomain = incoming.attempts.find(({ provider }) => provider === "Hunter")?.website?.domain;
        const previousDomain = previous?.result?.attempts.find(({ provider }) => provider === "Hunter")?.website?.domain;
        const current = incomingDomain === previousDomain && !choice ? previous?.result : undefined;
        const people = new Map<string, MonetaryContact>();
        for (const person of [...(current?.contacts ?? []), ...(current?.additionalContacts ?? [])]) {
          if (person.workEmail && person.emailVerification === "verified") {
            people.set(monetaryContactKey(key, person), person);
          }
        }
        for (const person of [...incoming.contacts, ...incoming.profileOnly, ...incoming.additionalContacts]) {
          const id = monetaryContactKey(key, person);
          const previous = people.get(id);
          people.set(id, !person.workEmail && previous?.workEmail ? {
            ...person, workEmail: previous.workEmail, emailVerification: previous.emailVerification,
            emailSource: previous.emailSource ?? (previous.provider === "Hunter" ? "Hunter" : undefined),
          } : person);
        }
        const next = { ...incoming, ...groupMonetaryContacts([...people.values()]) };
        const saved = { ...history.saved };
        for (const contact of [...next.contacts, ...next.additionalContacts]) {
          const contactKey = monetaryContactKey(key, contact);
          if (contact.workEmail && saved[contactKey]) saved[contactKey] = { companyKey: key, contact };
        }
        return {
          ...history, saved, companies: { ...history.companies, [key]: {
            result: next, searchedAt: new Date().toISOString(),
            website: choice && incomingDomain === choice.domain ? choice : previous?.website,
          } },
        };
      }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not look up contacts.");
    } finally {
      setBusy(false);
    }
  }

  async function findWorkEmail(contact: MonetaryContact) {
    if (busy || finding || !company?.companyName) return;
    const currentResult = result ?? EMPTY_RESULT;
    const manual = contact.provider === "Hunter" && !contact.location;
    if (manual) setManualMessage("");
    setFinding(contact);
    setEmailMessages((current) => {
      const next = new Map(current);
      next.delete(contact);
      return next;
    });
    try {
      const response = await fetch("/api/hunter-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: company.companyId, companyName: company.companyName, name: contact.name,
          website: companyHistory?.website ?? (hunter?.website?.evidenceUrl ? hunter.website : undefined) }),
      });
      const data = await response.json() as { workEmail?: string | null; emailSource?: MonetaryEmailSource; note?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Hunter could not complete the lookup.");
      const workEmail = data.workEmail;
      if (!workEmail) throw new Error(data.note ?? "No verified work email found for this contact.");
      const verified = { ...contact, workEmail, emailVerification: "verified" as const, emailSource: data.emailSource ?? "Hunter" };
      const candidateKey = monetaryContactKey(companyKey, contact);
      const people = rankedPeople.filter((person) => monetaryContactKey(companyKey, person) !== candidateKey);
      saveResult(companyKey, {
        ...currentResult,
        ...groupMonetaryContacts([...people, verified]),
      }, verified);
      if (manual) setFullName("");
    } catch (lookupError) {
      const message = lookupError instanceof Error ? lookupError.message : "The email lookup could not complete.";
      if (manual) setManualMessage(message);
      else setEmailMessages((current) => new Map(current).set(contact, message));
    } finally {
      setFinding(null);
    }
  }

  function finderFor(contact: MonetaryContact) {
    if (contact.workEmail) return undefined;
    const hasFullName = /^\S+\s+\S/.test(contact.name.trim()) && !/[*•]/.test(contact.name);
    return {
      disabled: busy || Boolean(finding) || !hasFullName,
      pending: finding === contact,
      message: hasFullName ? emailMessages.get(contact) : "Hunter needs a full name.",
      lookup: () => void findWorkEmail(contact),
    };
  }

  function renderContact(contact: MonetaryContact) {
    return <ContactCard key={monetaryContactKey(companyKey, contact)} contact={contact}
      finder={finderFor(contact)}
      outsideCount={Boolean(contact.icpMatch !== false && contact.workEmail &&
        !result?.contacts.some((counted) => counted === contact))}
      saved={Boolean(history.saved[monetaryContactKey(companyKey, contact)])}
      onSave={() => saveContact(companyKey, contact)}
      onDraft={(verified) => openDraft(companyKey, verified, company)} />;
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="text-xl font-semibold">Monetary accounts</h2>
      <p className="text-sm text-slate-600">
        Find contacts searches Hunter across all departments. Target roles appear first, and other named contacts stay visible.
        A person’s location may be unverified.
      </p>
      <p className="text-sm text-slate-600">
        GetProspect and Prospeo search for target roles when Hunter and the directory have no matches.
        An individual email check tries Hunter, then Prospeo, then GetProspect as needed.
        Searches and email checks use included Free-plan allowances.
        Only unique, verified work emails count toward five. Contacts outside target roles stay separate.
      </p>
      {storageWarning && <p role="status" className="text-sm text-amber-800">
        Browser storage is unavailable. Your latest changes will disappear when you close or reload this page.
      </p>}
      {accountError && <p role="alert" className="text-sm text-red-700">Could not load the Companies tab.</p>}
      {!accounts && !accountError && <p role="status" className="text-sm">Loading monetary accounts…</p>}
      {accounts && (
        <div className="space-y-2">
          <label className="grid max-w-xl gap-1 text-sm font-medium">
            Search companies
            <input type="search" value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="rounded-lg border border-slate-300 p-2" />
          </label>
          <p className="text-xs text-slate-500">
            {rows.length === 0 ? "No matching companies." : `Showing ${rows.length} matching ${rows.length === 1 ? "company" : "companies"}.`}
          </p>
          {rows.length > 0 && (
            <ul aria-label="Monetary companies" className="grid max-h-96 gap-2 overflow-y-auto p-1">
              {rows.map(({ account, index }) => {
                const active = selected === index;
                const previous = history.companies[companyKeyFor(account)]?.result;
                const needsReview = previous?.attempts.some(({ websiteCandidates }) => websiteCandidates?.length);
                const status = needsReview ? "Needs website review" : previous
                  ? `${previous.contacts.length} of ${MONETARY_CONTACT_LIMIT} verified` : "Not searched";
                return (
                  <li key={index} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3
                    ${active ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white"}`}>
                    <button type="button" aria-pressed={active} disabled={lookupPending}
                      onClick={() => selectCompany(index)}
                      className="min-w-0 break-words text-left text-sm font-semibold text-slate-900 enabled:hover:text-indigo-700">
                      {account.companyName}
                      <span className="mt-1 block text-xs font-normal text-slate-600">{status}</span>
                    </button>
                    <button type="button" disabled={lookupPending} onClick={() => void search(index)}
                      aria-label={busy && active ? `Finding contacts for ${account.companyName}` : `Find contacts for ${account.companyName}`}
                      className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 enabled:hover:bg-indigo-50 disabled:opacity-50">
                      {busy && active ? "Checking providers…" : previous ? "Search again" : "Find contacts"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {company?.companyName && <div>
        <h3 className="text-base font-semibold text-slate-900">{company.companyName}</h3>
        <div aria-live="polite" className="mt-1 space-y-1 text-sm text-slate-600">
          {busy ? <p>Checking the company website and looking for contacts…</p> : result && <>
            <p className="font-medium text-slate-900">
              {candidates.length ? "Choose the right website to continue." :
                `${verifiedCount} of ${MONETARY_CONTACT_LIMIT} verified work emails · ${peopleCount} ${peopleCount === 1 ? "person" : "people"} found`}
            </p>
            {hunter?.website?.domain && <p>Website used by Hunter <span className="font-medium">{hunter.website.domain}</span></p>}
            {companyHistory?.searchedAt && <p>Last searched <time dateTime={companyHistory.searchedAt}>
              {new Date(companyHistory.searchedAt).toLocaleString()}
            </time></p>}
            {!candidates.length && !verifiedCount && !peopleCount && <p>{
              hunter?.state === "quota" ? "Hunter’s included credit or rate limit was reached." :
              hunter?.state === "skipped" || hunter?.state === "unavailable" ? "Hunter could not complete the search. Check the search details below." :
              hunter?.website ? "No named contacts came back. Check Provider results to see which sources searched and what happened." :
              "No company website was confirmed. Add the official website to the tracker and search again."
            }</p>}
            {!verifiedCount && result.profileOnly.length > 0 && <p>Check a person’s work email below.</p>}
          </>}
        </div>
        {companyHistory?.website && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>Saved website {companyHistory.website.domain}</span>
          <button type="button" disabled={lookupPending} onClick={forgetWebsite}
            className="text-indigo-700 underline disabled:opacity-50">Clear saved website</button>
        </div>}
      </div>}
      {candidates.length > 0 && <ul aria-label="Possible company websites" className="grid gap-2 sm:grid-cols-2">
        {candidates.map((website) => <li key={website.domain} className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
          <h4 className="font-semibold">{website.domain}</h4>
          <p className="text-slate-600">{website.locationEvidence ?? website.location}</p>
          {website.reasons?.map((reason) => <p key={reason} className="text-slate-600">{reason}</p>)}
          {website.evidenceUrl && <a href={website.evidenceUrl} target="_blank" rel="noopener noreferrer"
            className="block text-indigo-700 underline">See location evidence</a>}
          <button type="button" disabled={lookupPending} onClick={() => selected !== null && void search(selected, website)}
            aria-label={`Use ${website.domain} and find contacts`}
            className="rounded-lg border border-indigo-700 px-3 py-1.5 font-semibold text-indigo-700 disabled:opacity-50">
            Use website and find contacts
          </button>
        </li>)}
      </ul>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {result && (
        <div className="space-y-4">
          {peopleCount > 0 && (
            <label className="flex w-fit items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={hideWithEmail} onChange={(event) => setHideWithEmail(event.target.checked)} />
              Hide contacts with verified emails
            </label>
          )}
          {hiddenCount > 0 && (
            <p role="status" className="text-sm text-slate-600">
              {hiddenCount} {hiddenCount === 1 ? "contact hidden" : "contacts hidden"}.{" "}
              <button type="button" className="text-indigo-700 underline" onClick={() => setHideWithEmail(false)}>
                Show contacts with verified emails
              </button>
            </p>
          )}
          {targetPeople.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">Target contacts ({targetPeople.length})</h4>
              {targetPeople.map(renderContact)}
            </div>
          )}
          {otherPeople.length > 0 && (
            <details className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
              <summary className="cursor-pointer font-medium">Other roles ({otherPeople.length})</summary>
              {otherPeople.map(renderContact)}
            </details>
          )}
        </div>
      )}
      {company && (
        <details className="max-w-xl rounded-xl border border-slate-200 p-3 text-sm">
        <summary className="cursor-pointer font-medium">Look up someone I know</summary>
        <form className="mt-3 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!company.companyName || !/^[^\s]+\s+\S/.test(fullName.trim())) return;
            void findWorkEmail({
              name: fullName.trim(), company: company.companyName, title: "", location: "",
              linkedinUrl: null, workEmail: null, sfuAlumni: false, provider: "Hunter",
            });
          }}>
          <label className="grid gap-1 font-medium">
            Contact full name
            <input value={fullName} maxLength={160} disabled={busy || Boolean(finding)}
              onChange={(event) => { setFullName(event.target.value); setManualMessage(""); }}
              className="rounded-lg border border-slate-300 p-2" />
          </label>
          <p className="text-slate-600">
            Check the work email for someone you already know.
          </p>
          <button type="submit"
            disabled={busy || Boolean(finding) || !/^\S+\s+\S/.test(fullName.trim())}
            className="w-fit rounded-lg border border-indigo-700 px-3 py-1.5 font-semibold text-indigo-700 disabled:opacity-50">
            {finding?.provider === "Hunter" && !finding.location ? "Checking work email…" : "Find verified work email"}
          </button>
          {manualMessage && <p role="status">{manualMessage}</p>}
        </form>
        </details>
      )}
      {Boolean(result?.attempts.length) && result && <details open={!peopleCount} className="rounded-xl border border-slate-200 p-3 text-sm">
            <summary className="cursor-pointer font-medium">Provider results</summary>
            <ul className="mt-1 space-y-1 text-sm text-slate-600">
              {result.attempts.map(({ provider, state, message, hunterCounts }, index) => (
                <li key={`${provider}-${index}`}>
                  {provider}: {STATUS[state]}{message ? ` — ${message}` : ""}
                  {hunterCounts && <HunterBreakdown counts={hunterCounts} />}
                </li>
              ))}
            </ul>
      </details>}
      <details className="rounded-xl border border-slate-200 p-3 text-sm">
        <summary className="cursor-pointer font-medium">Saved contacts ({savedContacts.length})</summary>
        <p className="mt-2 text-slate-600">Saved in this browser.</p>
        {savedContacts.length === 0 ? <p className="mt-2 text-slate-600">Use Save contact to keep people from your search results.</p> :
          <ul className="mt-2 grid gap-2">
            {savedContacts.map(({ companyKey: key, contact }) => <li key={monetaryContactKey(key, contact)}>
              <p className="mb-1 font-medium">{contact.company}</p>
              <ContactCard contact={contact} saved onSave={() => saveContact(key, contact)}
                onDraft={(verified) => openDraft(key, verified, accounts?.find((account) => companyKeyFor(account) === key))} />
            </li>)}
          </ul>}
      </details>
      <dialog ref={draftDialog} aria-labelledby={draftTitleId}
        className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-950 shadow-lg backdrop:bg-slate-950/50">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 id={draftTitleId} className="text-base font-semibold">Personalized email draft</h3>
          <form method="dialog">
            <button type="submit" className="rounded-lg border border-slate-300 px-3 py-1.5">Close</button>
          </form>
        </div>
        {draftTarget && <MonetaryDraft
          key={JSON.stringify([draftTarget.companyId, draftTarget.companyName, draftTarget.website, draftTarget.contact.workEmail])}
          target={draftTarget} sendStatus={history.sent?.[draftTarget.contact.workEmail.toLowerCase()]}
          researchFor={(target) => researchMonetaryCompany(target, researchByCompany.current)} />}
      </dialog>
    </section>
  );
}
