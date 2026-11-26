"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The one page the proxy gate leaves open. Team members enter the shared access
 * code once; the cookie lasts 30 days on that browser.
 */
export default function UnlockPage() {
  const router = useRouter();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status.kind === "checking") return;
    const code = String(
      new FormData(event.currentTarget).get("code") ?? "",
    ).trim();
    if (!code) {
      setStatus({ kind: "error", message: "Enter the access code." });
      return;
    }
    setStatus({ kind: "checking" });

    try {
      const response = await fetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? "The code could not be checked.");
      }

      router.push("/");
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error ? error.message : "The code could not be checked.",
      });
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-slate-950">
      <form
        onSubmit={unlock}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">
          Outreach SDR
        </p>
        <h1 className="mt-1 text-xl font-semibold">Team access</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Enter the shared access code. You will stay signed in on this browser
          for 30 days.
        </p>
        <input
          name="code"
          type="password"
          maxLength={200}
          autoFocus
          placeholder="Access code"
          className="mt-4 w-full rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <button
          type="submit"
          disabled={status.kind === "checking"}
          className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {status.kind === "checking" ? "Checking..." : "Unlock"}
        </button>
        {status.kind === "error" && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-200">
            {status.message}
          </p>
        )}
      </form>
    </main>
  );
}
