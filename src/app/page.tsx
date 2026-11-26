import { WorkspaceTabs } from "./workspace-tabs";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-4 sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">
            Outreach SDR
          </p>
          <h1 className="mt-1 text-xl font-semibold">In-kind Outreach</h1>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
        <WorkspaceTabs />
      </div>
    </main>
  );
}
