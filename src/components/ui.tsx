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

/** Parse a comma-separated multi-select param, keeping only known values. */
export function multiParam(sp: SP, key: string, known: string[]): string[] {
  const raw = param(sp, key);
  return raw ? raw.split(",").filter((v) => known.includes(v)) : [];
}

/**
 * Chips that toggle values in a comma-separated search param. No param = everything on;
 * turning off the last one (or turning everything back on) clears the param.
 */
export function ToggleChips({
  sp,
  name,
  options,
  path,
}: {
  sp: SP;
  name: string;
  options: { value: string; label: string; color?: string | null }[];
  path: string;
}) {
  const all = options.map((o) => o.value);
  const selected = multiParam(sp, name, all);
  const active = selected.length ? selected : all;

  const hrefWith = (values: string[]) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (typeof v === "string" && k !== "ok" && k !== "error" && k !== name) next.set(k, v);
    }
    if (values.length && values.length < all.length) next.set(name, all.filter((v) => values.includes(v)).join(","));
    const qs = next.toString();
    return qs ? `${path}?${qs}` : path;
  };
  const hrefFor = (value: string) =>
    hrefWith(active.includes(value) ? active.filter((v) => v !== value) : [...active, value]);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {options.map((o) => {
        const on = active.includes(o.value);
        return (
          <Link
            key={o.value}
            href={hrefFor(o.value)}
            aria-pressed={on}
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs ${
              on ? "border-accent bg-accent text-white" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {o.color && <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: o.color }} />}
            {o.label}
          </Link>
        );
      })}
      {selected.length > 0 && (
        <span className="ml-2 text-xs text-muted">
          {selected.length} of {all.length} ·{" "}
          <Link className="underline hover:text-foreground" href={hrefWith([])}>
            show all
          </Link>
        </span>
      )}
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

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`pill ${STATUS_STYLE[status] ?? ""}`}>{label ?? status}</span>;
}

/** Put/Call tag: outlined (unlike the filled outcome pills) and colour-coded, away from gain/loss green/red. */
export function OptionTypePill({ type }: { type: "put" | "call" }) {
  return (
    <span
      className={`pill ${
        type === "put"
          ? "border border-fuchsia-500/60 text-fuchsia-600 dark:text-fuchsia-300"
          : "border border-sky-500/60 text-sky-600 dark:text-sky-300"
      }`}
    >
      {type === "put" ? "Put" : "Call"}
    </span>
  );
}

export function StreamDot({ color }: { color?: string | null }) {
  return <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: color ?? "#888" }} />;
}
