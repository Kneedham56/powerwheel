"use client";

import Link from "next/link";
import { useState } from "react";
import { importCsvStep, type ImportStep } from "./actions";

interface Props {
  accounts: { id: string; name: string }[];
}

interface Totals {
  applied: number;
  skipped: number;
  warnings: string[];
}

export function ImportForm({ accounts }: Props) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [plan, setPlan] = useState<ImportStep | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState<string>("");
  const [finished, setFinished] = useState(false);

  async function go(dryRun: boolean) {
    if (!file) return setError("Choose the CSV file first.");
    setBusy(true);
    setError("");
    setFinished(false);
    setTotals(null);
    try {
      const text = await file.text();
      let cursor = 0;
      const acc: Totals = { applied: 0, skipped: 0, warnings: [] };
      for (;;) {
        setProgress(dryRun ? "Reading the file…" : cursor ? `Importing… ${cursor} events done` : "Importing…");
        const step = await importCsvStep(accountId, text, cursor, dryRun);
        if (!step.ok) throw new Error(step.error ?? "Import failed");
        setPlan(step);
        if (dryRun) break;
        acc.applied += step.applied;
        acc.skipped += step.skipped;
        acc.warnings.push(...step.warnings);
        setTotals({ ...acc });
        if (step.next === null) {
          setFinished(true);
          break;
        }
        cursor = step.next;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const s = plan?.stats;
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Which account is this file for?</label>
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={busy}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Robinhood account activity report (.csv)</label>
            <input
              type="file"
              accept=".csv,text/csv"
              className="input"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPlan(null);
                setTotals(null);
                setFinished(false);
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" disabled={busy || !file} onClick={() => go(true)}>
            Preview
          </button>
          <button className="btn" disabled={busy || !file} onClick={() => go(false)}>
            Import
          </button>
          {busy && <span className="text-sm text-muted">{progress}</span>}
        </div>
        {error && <div className="rounded-md border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>}
      </div>

      {plan && s && (
        <div className="card space-y-2 text-sm">
          <h2 className="font-medium">
            {finished ? "Imported" : "In this file"}
            {plan.range && (
              <span className="ml-2 text-xs font-normal text-muted">
                {plan.range.from} → {plan.range.to}
              </span>
            )}
          </h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-5">
            <span>{s.opened} contracts sold</span>
            <span>{s.boughtBack} bought back</span>
            <span>{s.expired} expired</span>
            <span>{s.assigned} assigned</span>
            <span>{s.rolls} rolls</span>
          </div>
          {totals && (
            <p className="text-muted">
              {finished ? "Done" : "Working"}: {totals.applied} new events added, {totals.skipped} already imported.
            </p>
          )}
          {finished && (
            <p>
              <Link href="/" className="text-accent underline">
                Go to Reports
              </Link>
            </p>
          )}
          {Object.keys(plan.ignored).length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Rows not tracked ({Object.values(plan.ignored).reduce((a, b) => a + b, 0)})</summary>
              <ul className="mt-1 list-disc pl-5">
                {Object.entries(plan.ignored).map(([why, n]) => (
                  <li key={why}>
                    {n} × {why}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {(() => {
            const all = [...plan.planWarnings, ...(totals?.warnings ?? [])];
            return (
              all.length > 0 && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">Heads up ({all.length})</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {all.slice(0, 40).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {all.length > 40 && <li>…and {all.length - 40} more</li>}
                  </ul>
                </details>
              )
            );
          })()}
        </div>
      )}
    </div>
  );
}
