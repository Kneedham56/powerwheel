import Link from "next/link";
import type { ReactNode } from "react";

type SP = Record<string, string | string[] | undefined>;

export function param(sp: SP, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

export function Flash({ sp }: { sp: SP }) {
  const ok = param(sp, "ok");
  const error = param(sp, "error");
  if (!ok && !error) return null;
  return (
    <div
      className={`mb-4 rounded-md border px-3 py-2 text-sm ${
        error ? "border-loss/40 bg-loss/10 text-loss" : "border-gain/40 bg-gain/10 text-gain"
      }`}
    >
      {error ?? ok}
    </div>
  );
}

export function PageTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">{children}</h1>
      {right}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Row of link-chips that set one search param while keeping the others. */
export function Chips({
  sp,
  name,
  options,
  path,
}: {
  sp: SP;
  name: string;
  options: { value: string; label: string }[];
  path: string;
}) {
  const current = param(sp, name) ?? "";
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const next = new URLSearchParams();
        for (const [k, v] of Object.entries(sp)) {
          if (typeof v === "string" && k !== "ok" && k !== "error") next.set(k, v);
        }
        if (o.value) next.set(name, o.value);
        else next.delete(name);
        const active = current === o.value;
        return (
          <Link
            key={o.value || "__default"}
            href={`${path}?${next.toString()}`}
            className={`rounded-full border px-3 py-1 text-xs ${
              active ? "border-accent bg-accent text-white" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent/15 text-accent",
  expired: "bg-gain/15 text-gain",
  closed: "bg-foreground/10 text-foreground",
  assigned: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  rolled: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${STATUS_STYLE[status] ?? ""}`}>{status}</span>;
}

export function StreamDot({ color }: { color?: string | null }) {
  return <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: color ?? "#888" }} />;
}
