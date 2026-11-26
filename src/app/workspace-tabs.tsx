"use client";

import { useState } from "react";

import { GoalPanel } from "./goal-panel";
import { InKindPanel } from "./in-kind-panel";
import { InKindFollowUpsPanel } from "./in-kind-follow-ups-panel";
import { MonetaryPanel } from "./monetary-panel";

type Tab = "inkind" | "goal" | "followups" | "monetary";

/**
 * All panels stay mounted and the inactive ones are hidden, so switching tabs
 * never discards loaded drafts or the in-kind list.
 */
export function WorkspaceTabs() {
  const [tab, setTab] = useState<Tab>("inkind");

  const tabClass = (selected: boolean) =>
    selected
      ? "rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
      : "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100";

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "inkind", label: "In-kind" },
    { key: "monetary", label: "Monetary" },
    { key: "followups", label: "Follow-ups" },
    { key: "goal", label: "Goal" },
  ];

  return (
    <>
      <div className="mb-6 flex flex-wrap gap-2" role="tablist">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={tabClass(tab === key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={tab === "inkind" ? "" : "hidden"}>
        <InKindPanel active={tab === "inkind"} />
      </div>
      <div className={tab === "goal" ? "" : "hidden"}>
        <GoalPanel active={tab === "goal"} />
      </div>
      {tab === "followups" && <InKindFollowUpsPanel />}
      {tab === "monetary" && <MonetaryPanel />}
    </>
  );
}
