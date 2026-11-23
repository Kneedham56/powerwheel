import Link from "next/link";
import { listSummaries, type RunEntry } from "@/lib/skynet-runs";
import { pooled, pooledSections, resolveRun, rulesCompared, type PooledRow, type PooledSection, type StudyFile } from "@/lib/skynet-study";

const spct = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`);
const tone = (n: number | null | undefined) => (!n ? "" : n > 0 ? "text-gain" : "text-loss");
const runHref = (id: string) => `/skynet?view=runs&run=${encodeURIComponent(id)}`;

/** The obvious way from a Study row to the run's full view (summary, chart, year → week → trades). */
function OpenRun({ id }: { id: string | null | undefined }) {
  if (!id) return <span className="text-muted">—</span>;
  return (
    <Link href={runHref(id)} className="whitespace-nowrap rounded border border-accent/40 px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10">
      Open in All runs →
    </Link>
  );
}

export function Tabs({ view }: { view: string }) {
  const tab = (v: string, label: string) => (
    <Link
      href={`/skynet?view=${v}`}
      className={`rounded px-2.5 py-1 text-sm ${view === v ? "bg-accent/15 font-medium text-accent" : "text-muted hover:bg-foreground/5 hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="flex gap-1">
      {tab("study", "Study")}
      {tab("runs", "All runs")}
    </nav>
  );
}

/** The Study tab: the rulesets side by side, the hand-picked runs (data/skynet/study.json), and the pooled sweeps. */
export function Study({ study, runs }: { study: StudyFile; runs: RunEntry[] }) {
  const sums = listSummaries(runs);
  const sumOf = (id: string) => sums.find((s) => s.id === id);
  const cmp = study.compare?.length ? rulesCompared(study.compare) : null;
  return (
    <>
      {study.intro && (
        <section className="card text-sm">
          <p>{study.intro}</p>
          {study.updated && <p className="mt-1 text-xs text-muted">List updated {study.updated}.</p>}
        </section>
      )}

      {cmp && (
        <section className="card overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">The rulesets, side by side</h2>
            <span className="text-xs text-muted">only the settings that differ; bold = changed from the column to its left; everything else is Kindred</span>
          </div>
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-medium">Setting</th>
                {cmp.names.map((n) => (
                  <th key={n} className="px-2 text-right font-medium">
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cmp.rows.map((r) => (
                <tr key={r.path} className="border-b border-border/60">
                  <td className="py-1.5 pr-3">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className={`whitespace-nowrap px-2 text-right tabular-nums ${i > 0 && v !== r.values[i - 1] ? "font-semibold" : "text-muted"}`}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {study.sections.map((sec) => (
        <section key={sec.title} className="card overflow-x-auto">
          <h2 className="font-medium">{sec.title}</h2>
          {sec.note && <p className="mt-0.5 text-xs text-muted">{sec.note}</p>}
          <table className="mt-2 w-full min-w-[64rem] text-right text-xs tabular-nums">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="min-w-[11rem] py-1.5 text-left font-medium">Run</th>
                <th className="font-medium">Period</th>
                <th className="font-medium" title="the whole period's return, start to end">Total</th>
                <th className="font-medium" title="SPY's return over the same weeks (price only)">SPY total</th>
                <th className="font-medium">CAGR</th>
                <th className="font-medium">SPY</th>
                <th className="font-medium">Max DD</th>
                <th className="font-medium">Sharpe</th>
                <th className="font-medium">Worst year</th>
                <th className="pl-3 text-left font-medium">Why look</th>
              </tr>
            </thead>
            <tbody>
              {sec.runs.map((r) => {
                const e = resolveRun(r, runs);
                const s = e ? sumOf(e.id) : undefined;
                return (
                  <tr key={r.label} className="border-b border-border/60 align-top">
                    <td className="py-1.5 text-left">
                      {e ? (
                        <Link href={runHref(e.id)} className="font-medium hover:underline">
                          {r.label}
                        </Link>
                      ) : (
                        <span className="text-muted">{r.label} (not on this machine)</span>
                      )}
                      {e && (
                        <div className="mt-1">
                          <OpenRun id={e.id} />
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-muted">
                      {r.from.slice(0, 4)}–{r.to.slice(0, 4)}
                    </td>
                    <td className={`font-medium ${tone(s?.total.ret)}`}>{spct(s?.total.ret, 0)}</td>
                    <td className="text-muted">{spct(s?.total.spy, 0)}</td>
                    <td className={tone(s?.total.cagr)}>{spct(s?.total.cagr)}</td>
                    <td className="text-muted">{spct(s?.total.spyCagr)}</td>
                    <td className="text-loss">{spct(s?.total.dd, 0)}</td>
                    <td>{s?.total.sharpe == null ? "—" : s.total.sharpe.toFixed(2)}</td>
                    <td className="text-loss">{s ? spct(Math.min(...s.years.map((y) => y.return)), 0) : "—"}</td>
                    <td className="max-w-[30rem] pl-3 text-left text-muted">{r.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      {pooledSections(study).map((P) => (
        <Pooled key={P.title} P={P} sums={sums} />
      ))}
    </>
  );
}

/** One pooled table: each variant averaged over the full list and random slices of it, against the control. */
function Pooled({ P, sums }: { P: PooledSection; sums: ReturnType<typeof listSummaries> }) {
  const pool = pooled(P, sums);
  if (!pool.rows.length) return null;
  const poolRows: PooledRow[] = [...(pool.control ? [pool.control] : []), ...pool.rows];
  return (
    <section className="card overflow-x-auto">
      <h2 className="font-medium">{P.title}</h2>
      {P.note && <p className="mt-0.5 text-xs text-muted">{P.note}</p>}
      <table className="mt-2 w-full min-w-[74rem] text-right text-xs tabular-nums">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1.5 text-left font-medium">Variant</th>
            <th className="font-medium" title="the full list plus random 80% slices of it">Universes</th>
            <th className="font-medium">Avg CAGR</th>
            <th className="font-medium">vs control</th>
            <th className="font-medium">Beat control</th>
            <th className="font-medium">Avg max DD</th>
            <th className="font-medium" title="each list's worst calendar year, averaged">Avg worst year</th>
            <th className="font-medium">Avg Sharpe</th>
            {pool.rows[0].years.map((y) => (
              <th key={y.year} className="font-medium" title="this year's return minus the control's, averaged over the universes (how many beat it)">
                {y.year}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {poolRows.map((r) => {
            const base = r === pool.control;
            return (
              <tr key={r.label} className="border-b border-border/60 align-top">
                <td className="py-1.5 text-left">
                  {r.fullId ? (
                    <Link href={runHref(r.fullId)} className="font-medium hover:underline">
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                  {r.why && <div className="max-w-[22rem] text-muted">{r.why}</div>}
                  {r.fullId && (
                    <div className="mt-1" title="this variant's run on the full list">
                      <OpenRun id={r.fullId} />
                    </div>
                  )}
                </td>
                <td className="text-muted">{r.n}</td>
                <td className={tone(r.cagr)}>{spct(r.cagr)}</td>
                <td className={base ? "text-muted" : tone(r.delta)}>{base ? "base" : spct(r.delta)}</td>
                <td className="text-muted">{base ? "—" : `${r.better}/${r.n}`}</td>
                <td className="text-loss">{spct(r.dd, 1)}</td>
                <td className="text-loss">{spct(r.worst, 1)}</td>
                <td>{r.sharpe.toFixed(2)}</td>
                {r.years.map((y) => (
                  <td key={y.year} className={`whitespace-nowrap px-1 ${base ? "" : y.delta > 0 ? "bg-gain/15" : y.delta < 0 ? "bg-loss/15" : ""}`}>
                    {base ? "—" : `${spct(y.delta, 0)} (${y.better})`}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
