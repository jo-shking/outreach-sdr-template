import type { MonetaryContact, MonetarySearchResult, MonetaryWebsite } from "./monetary-waterfall";

type CompanyHistory = { result?: MonetarySearchResult; searchedAt?: string; website?: MonetaryWebsite };
type SavedContact = { companyKey: string; contact: MonetaryContact };
type History = {
  companies: Record<string, CompanyHistory>;
  saved: Record<string, SavedContact>;
  sent?: Record<string, "pending" | "sent">;
};

const KEY = "misa.monetary.history.v1";
const EVENT = "misa:monetary-history";
const EMPTY: History = { companies: {}, saved: {} };
let cachedRaw: string | null = null;
let cached = EMPTY;
let memoryOnly = false;

export function getMonetaryHistory(): History {
  if (typeof window === "undefined" || memoryOnly) return cached;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    const parsed = raw ? JSON.parse(raw) as Partial<History> | null : null;
    cached = parsed?.companies && parsed.saved ? { companies: parsed.companies, saved: parsed.saved, sent: parsed.sent } : EMPTY;
  } catch {
    return cached;
  }
  return cached;
}

export function getEmptyMonetaryHistory() {
  return EMPTY;
}

export function subscribeMonetaryHistory(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(EVENT, listener);
  };
}

export function updateMonetaryHistory(update: (history: History) => History) {
  cached = update(getMonetaryHistory());
  try {
    cachedRaw = JSON.stringify(cached);
    window.localStorage.setItem(KEY, cachedRaw);
    memoryOnly = false;
  } catch {
    memoryOnly = true;
  }
  window.dispatchEvent(new Event(EVENT));
  return !memoryOnly;
}

export function monetaryContactKey(companyKey: string, contact: MonetaryContact) {
  return JSON.stringify([companyKey, contact.name.trim().toLowerCase()]);
}

export function setMonetarySendStatus(email: string, status: "pending" | "sent" | null) {
  return updateMonetaryHistory((history) => {
    const key = email.toLowerCase();
    const sent = { ...history.sent };
    if (status) sent[key] = status;
    else delete sent[key];
    return { ...history, sent };
  });
}
