/** Shared battery artwork for monetary and in-kind progress. */
export function ProgressBattery({ percent, full, label }: {
  percent: number;
  full: boolean;
  label: string;
}) {
  return (
    <svg
      viewBox="0 0 360 140"
      className="w-full max-w-xl"
      role="img"
      aria-label={label}
    >
      {/* body */}
      <rect
        x="8"
        y="30"
        width="316"
        height="80"
        rx="14"
        className="fill-white stroke-slate-400"
        strokeWidth="4"
      />
      {/* terminal */}
      <rect
        x="328"
        y="55"
        width="18"
        height="30"
        rx="5"
        className="fill-slate-400"
      />
      {/* charge */}
      {percent > 0 && (
        <rect
          x="16"
          y="38"
          width={Math.max(8, 300 * (percent / 100))}
          height="64"
          rx="9"
          className={full ? "fill-emerald-500" : "fill-emerald-400"}
        />
      )}
      {/* segment ticks */}
      {[1, 2, 3].map((i) => (
        <line
          key={i}
          x1={16 + 75 * i}
          y1="38"
          x2={16 + 75 * i}
          y2="102"
          className="stroke-white"
          strokeWidth="3"
        />
      ))}
      {/* bolt */}
      <path
        d="M178 44 L150 78 L168 78 L158 100 L192 64 L172 64 Z"
        className={percent >= 55 ? "fill-white" : "fill-amber-400"}
        stroke="none"
      />
    </svg>
  );
}
