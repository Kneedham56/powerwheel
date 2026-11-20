import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RaceChart } from "@/components/race/RaceChart";
import { WeekTrades } from "@/components/race/WeekTrades";
import { Expandable, OptionTypePill, PageTitle, Stat, StatusPill } from "@/components/ui";
import { gradeAi, type GradedTrade, type RaceState, type Review, type Trade } from "@/lib/race";
import { loadRace } from "@/lib/race-db";
import { AI, RULES_VERSION, dayLabel } from "@/lib/rules";

// Private page (behind the password). Kyle's side is shown as returns and per-trade results, never his account value.

export const metadata: Metadata = {
  title: "AI vs Kyle · PowerWheel",
  description: "A paper AI running the same wheel rules, against the real Individual account.",
};

const spct = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`);
const pctU = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(d)}%`);
const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const px = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const tone = (n: number | null | undefined) => (!n ? "" : n > 0 ? "text-gain" : "text-loss");

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {note && <p className="mt-0.5 max-w-3xl text-sm text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Bullets({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted">{title}</div>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

const WEEK_COLS = "grid-cols-[1rem_minmax(8rem,1.4fr)_repeat(6,minmax(4.5rem,1fr))]";

function GradedTable({ trades }: { trades: GradedTrade[] }) {
  if (!trades.length) return <p className="text-xs text-muted">No trades finished this week.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Strike</th>
          <th>Type</th>
          <th>Qty</th>
          <th>Opened → closed</th>
          <th>Outcome</th>
          <th>Premium</th>
          <th>Score</th>
          <th>Early close vs holding</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t, i) => (
          <tr key={i}>
            <td className="font-medium">{t.symbol}</td>
            <td>{px(t.strike)}</td>
            <td>{t.type === "put" || t.type === "call" ? <OptionTypePill type={t.type} /> : t.type}</td>
            <td>{t.contracts}</td>
            <td>
              {dayLabel(t.opened)} → {dayLabel(t.closed)}
              {t.rolls ? `, ${t.rolls} roll${t.rolls > 1 ? "s" : ""}` : ""}
            </td>
            <td>
              <span className={`pill ${t.result === "win" ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"}`}>{t.result}</span>{" "}
              <span className="text-muted">{t.outcome}</span>
            </td>
            <td>{usd(t.premium)}</td>
            <td className={tone(t.score)}>{usd(t.score)}</td>
            <td className="!text-left">
              {t.hold ? (
                <>
                  kept {pctU(t.hold.captured, 0)};{" "}
                  {t.hold.edge === null ? (
                    <span className="text-muted">hold result not known yet</span>
                  ) : (
                    <span className={tone(t.hold.edge)}>
                      {t.hold.edge >= 0 ? `beat holding by ${usd(t.hold.edge)}` : `holding was ${usd(-t.hold.edge)} better`}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted">held to expiry</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The Friday review: headline, what each side should steal, and both sides' finished trades graded the same way. */
function WeekReview({ r }: { r: Review }) {
  const n = r.narrative;
  const side = (title: string, s: Review["ai"], good?: string[], bad?: string[]) => (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 text-xs">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-muted tabular-nums">
          {s.stats.wins}W–{s.stats.losses}L · score <span className={tone(s.stats.score)}>{usd(s.stats.score)}</span>
          {s.stats.early ? ` · ${s.stats.early_beat_hold} of ${s.stats.early} early closes beat holding` : ""}
        </span>
      </div>
      {(good?.length || bad?.length) ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Bullets title="Good" items={good} />
          <Bullets title="Bad" items={bad} />
        </div>
      ) : null}
      <GradedTable trades={s.trades} />
    </div>
  );
  return (
    <div className="space-y-4">
      {n && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{n.headline}</p>
          {n.buybacks && <p className="text-xs text-muted">{n.buybacks}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            <Bullets title="Steal from Kyle (for the AI)" items={n.steal_from_kyle} />
            <Bullets title="Steal from the AI (for Kyle)" items={n.steal_from_ai} />
          </div>
        </div>
      )}
      {side("AI", r.ai, n?.ai_good, n?.ai_bad)}
      {side("Kyle", r.kyle, n?.kyle_good, n?.kyle_bad)}
    </div>
  );
}

function OpenPositions({ state }: { state: RaceState }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Open now</div>
      <table>
        <thead>
          <tr>
            <th>Position</th>
            <th>Ticker</th>
            <th>Theme</th>
            <th>Qty</th>
            <th>Strike or cost</th>
            <th>Expires</th>
            <th>Sold at or mark</th>
            <th>Value or collateral</th>
          </tr>
        </thead>
        <tbody>
          {state.options.map((o) => (
            <tr key={o.id}>
              <td>
                <OptionTypePill type={o.type} />
              </td>
              <td className="font-medium">{o.symbol}</td>
              <td>{o.theme}</td>
              <td>{o.contracts}</td>
              <td>{px(o.strike)}</td>
              <td>{dayLabel(o.expiration)}</td>
              <td>{px(o.price)}</td>
              <td>{o.type === "put" ? usd(o.strike * 100 * o.contracts) : "—"}</td>
            </tr>
          ))}
          {state.lots.map((l) => (
            <tr key={l.id}>
              <td>
                <span className="pill border border-border">Shares</span>
              </td>
              <td className="font-medium">{l.symbol}</td>
              <td>{l.theme}</td>
              <td>{l.shares}</td>
              <td>{px(l.cost)}</td>
              <td>—</td>
              <td>{px(l.mark)}</td>
              <td>{usd(l.shares * l.mark)}</td>
            </tr>
          ))}
          <tr>
            <td>Cash</td>
            <td colSpan={6} className="!text-left text-muted">
              below zero when assigned shares are bought on margin
            </td>
            <td className={tone(state.cash)}>{usd(state.cash)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default async function RacePage() {
  const data = await loadRace();
  if (!data) {
    return (
      <div className="card max-w-xl space-y-2">
        <h1 className="text-xl font-semibold">AI vs Kyle</h1>
        <p className="text-sm text-muted">No race yet. Start one with npm run race -- init (see docs/RACE.md).</p>
      </div>
    );
  }
  const { race, weeks, trades, state, reviews, lessons } = data;
  const last = weeks.at(-1);
  const today = new Date().toISOString().slice(0, 10);
  const graded = gradeAi([...trades].reverse() as Trade[], race.starts_on, today, {});
  const wins = graded.filter((g) => g.result === "win").length;
  const leader = last && last.week > 0 && last.opp_return !== null ? (last.ai_return > last.opp_return ? "The AI is ahead." : last.ai_return < last.opp_return ? "Kyle is ahead." : "They are tied.") : null;

  const byWeek = new Map<number, Trade[]>();
  for (const t of trades as Trade[]) byWeek.set(t.week, [...(byWeek.get(t.week) ?? []), t]);
  const openPremium = state?.current
    ? (byWeek.get(state.current.week) ?? []).filter((t) => t.action === "Sold put" || t.action === "Sold call").reduce((a, t) => a + (t.cash ?? 0), 0)
    : 0;

  return (
    <div className="space-y-8">
      <div>
        <PageTitle>AI vs Kyle</PageTitle>
        <p className="-mt-3 max-w-3xl text-sm text-muted">
          {last && last.week > 0 ? (
            <>
              After {last.week} week{last.week > 1 ? "s" : ""} the AI is <b className={tone(last.ai_return)}>{spct(last.ai_return)}</b> and Kyle is{" "}
              <b className={tone(last.opp_return)}>{spct(last.opp_return)}</b>. {leader}
            </>
          ) : (
            "The race has started; the first result lands Friday."
          )}{" "}
          The AI trades paper money by the same rules (version {RULES_VERSION}) with its own playbook.
          {state?.current ? ` Week ${state.current.week} is open until ${dayLabel(state.current.expiry)}.` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="AI return" value={spct(last?.ai_return)} tone={tone(last?.ai_return)} sub={last?.ai_week_return !== null && last?.ai_week_return !== undefined ? `${spct(last.ai_week_return)} last week` : undefined} />
        <Stat label="Kyle return" value={spct(last?.opp_return)} tone={tone(last?.opp_return)} sub={last?.opp_week_return !== null && last?.opp_week_return !== undefined ? `${spct(last.opp_week_return)} last week` : undefined} />
        <Stat label="AI max drawdown" value={pctU(last?.ai_max_drawdown)} sub="from a Friday high" />
        <Stat label="Kyle max drawdown" value={pctU(last?.opp_max_drawdown)} sub="from a Friday high" />
        <Stat label="AI win rate" value={graded.length ? pctU(wins / graded.length, 0) : "—"} sub={`${wins}–${graded.length - wins}, scored like Kyle's`} />
        <Stat label="AI paper account" value={usd(last?.ai_value)} sub={`started with ${usd(race.capital)}`} />
      </div>

      <Section id="chart" title="Cumulative return by week" note="Both start at zero. Kyle's line is the Individual account, adjusted for the deposits and withdrawals the Friday run knows about.">
        <div className="card">
          <RaceChart data={weeks.map((w) => ({ label: w.week === 0 ? "Start" : `Wk ${w.week}`, date: w.date, ai: w.ai_return, kyle: w.opp_return }))} />
        </div>
      </Section>

      <section id="weeks" className="card scroll-mt-4 overflow-x-auto">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-medium">Weekly detail</h2>
          <span className="text-xs text-muted">click a week to see its review and trades</span>
        </div>
        <div className="gtable">
          <div className={`ghead ${WEEK_COLS}`}>
            <span />
            <span className="text-left">Week</span>
            <span>AI week</span>
            <span>AI total</span>
            <span>Kyle week</span>
            <span>Kyle total</span>
            <span>AI premium</span>
            <span>AI exposure</span>
          </div>
          {state?.current && !weeks.some((w) => w.week === state.current!.week) && (
            <Expandable
              cols={WEEK_COLS}
              cells={[
                <span key="w">
                  Wk {state.current.week} · {dayLabel(state.current.expiry)} <StatusPill status="open" label="open" />
                </span>,
                "—",
                "—",
                "—",
                "—",
                usd(openPremium),
                "",
              ]}
            >
              <div className="space-y-4">
                <WeekTrades trades={byWeek.get(state.current.week) ?? []} />
                <OpenPositions state={state} />
              </div>
            </Expandable>
          )}
          {[...weeks].reverse().map((w) => {
            const r = reviews.find((x) => x.week === w.week);
            const wk = byWeek.get(w.week) ?? [];
            const ls = lessons.filter((l) => l.week === w.week && l.status !== "rejected");
            const has = w.week > 0 && (r || wk.length || ls.length || w.note);
            return (
              <Expandable
                key={w.week}
                cols={WEEK_COLS}
                cells={[
                  w.week === 0 ? `Start · ${dayLabel(w.date)}` : `Wk ${w.week} · ${dayLabel(w.date)}`,
                  <span key="a" className={tone(w.ai_week_return)}>{w.week ? spct(w.ai_week_return) : "—"}</span>,
                  <span key="b" className={tone(w.ai_return)}>{spct(w.ai_return)}</span>,
                  <span key="c" className={tone(w.opp_week_return)}>{w.week ? spct(w.opp_week_return) : "—"}</span>,
                  <span key="d" className={tone(w.opp_return)}>{spct(w.opp_return)}</span>,
                  w.week ? usd(w.premium) : "—",
                  w.leverage ? `${w.leverage.toFixed(2)}x` : "—",
                ]}
              >
                {has ? (
                  <div className="space-y-4">
                    {w.note && <p className="text-xs text-muted">{w.note}</p>}
                    {r ? <WeekReview r={r} /> : <p className="text-xs text-muted">No written review for this week.</p>}
                    {ls.length > 0 && (
                      <div>
                        <div className="mb-1 text-xs font-medium text-muted">Lessons (proposals until Kyle adopts them in RULES.md)</div>
                        <ul className="list-disc space-y-1 pl-5 text-sm">
                          {ls.map((l) => (
                            <li key={l.id}>
                              <span className="text-xs text-muted">{l.side === "ai" ? "AI" : l.side === "kyle" ? "Kyle" : "Both"} · {l.kind}:</span> {l.text}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <WeekTrades trades={wk} />
                  </div>
                ) : undefined}
              </Expandable>
            );
          })}
        </div>
      </section>

      <p className="text-xs text-muted">
        The AI&apos;s playbook: {AI.exposure.monday}x exposure after Monday, up to {AI.exposure.wednesday}x after Wednesday (ceiling {AI.exposure.ceiling}x), {pctU(AI.perTicker, 0)} per ticker, a
        Wednesday buyback at {pctU(AI.takeProfit, 0)} captured, stops on assigned shares and covered calls. Full rules in docs/RULES.md section 10. Runs Monday 7:00, Wednesday
        7:00 and Friday 1:15 Pacific.
      </p>
    </div>
  );
}
