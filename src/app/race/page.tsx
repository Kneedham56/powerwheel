import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { RaceChart } from "@/components/race/RaceChart";
import { PageTitle, Stat, param } from "@/components/ui";
import { gradeAi, type GradedTrade, type Review, type Trade } from "@/lib/race";
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

const ACTION_CLS: Record<string, string> = {
  "Sold put": "bg-gain/15 text-gain",
  "Sold call": "bg-gain/15 text-gain",
  Expired: "bg-gain/15 text-gain",
  "Bought back": "bg-accent/15 text-accent",
  Assigned: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "Called away": "bg-foreground/10 text-foreground",
  "Sold shares": "bg-loss/15 text-loss",
  Skipped: "bg-foreground/10 text-muted",
};

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

function GradedTable({ trades }: { trades: GradedTrade[] }) {
  if (!trades.length) return <p className="text-sm text-muted">No trades finished this week.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Trade</th>
            <th>Outcome</th>
            <th className="num">Premium</th>
            <th className="num">Score</th>
            <th>Early close vs holding</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={i}>
              <td>
                {t.symbol} {px(t.strike)} {t.type} ×{t.contracts}
                <span className="ml-1 text-xs text-muted">
                  {dayLabel(t.opened)} → {dayLabel(t.closed)}
                  {t.rolls ? `, ${t.rolls} roll${t.rolls > 1 ? "s" : ""}` : ""}
                </span>
              </td>
              <td>
                <span className={`pill ${t.result === "win" ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"}`}>{t.result}</span> <span className="text-xs text-muted">{t.outcome}</span>
              </td>
              <td className="num">{usd(t.premium)}</td>
              <td className={`num ${tone(t.score)}`}>{usd(t.score)}</td>
              <td className="text-xs">
                {t.hold ? (
                  <>
                    kept {pctU(t.hold.captured, 0)} of the premium;{" "}
                    {t.hold.edge === null ? (
                      <span className="text-muted">hold result not known yet</span>
                    ) : (
                      <span className={tone(t.hold.edge)}>{t.hold.edge >= 0 ? `beat holding by ${usd(t.hold.edge)}` : `holding was ${usd(-t.hold.edge)} better`}</span>
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
    </div>
  );
}

function ReviewCard({ r }: { r: Review }) {
  const n = r.narrative;
  const side = (title: string, s: Review["ai"], good?: string[], bad?: string[]) => (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        <div className="text-xs text-muted tabular-nums">
          {s.stats.wins}–{s.stats.losses} · score <span className={tone(s.stats.score)}>{usd(s.stats.score)}</span>
          {s.stats.early ? ` · ${s.stats.early_beat_hold} of ${s.stats.early} early closes beat holding` : ""}
        </div>
      </div>
      <Bullets title="Good" items={good} />
      <Bullets title="Bad" items={bad} />
      <GradedTable trades={s.trades} />
    </div>
  );
  return (
    <div className="space-y-3">
      {n ? (
        <div className="card space-y-3">
          <p className="font-medium">{n.headline}</p>
          {n.buybacks && <p className="text-sm text-muted">{n.buybacks}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <Bullets title="Steal from Kyle (for the AI)" items={n.steal_from_kyle} />
            <Bullets title="Steal from the AI (for Kyle)" items={n.steal_from_ai} />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">The written review lands after the Friday run.</p>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {side("AI", r.ai, n?.ai_good, n?.ai_bad)}
        {side("Kyle", r.kyle, n?.kyle_good, n?.kyle_bad)}
      </div>
    </div>
  );
}

export default async function RacePage({ searchParams }: PageProps<"/race">) {
  const sp = await searchParams;
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

  const reviewWeek = Number(param(sp, "review") ?? reviews[0]?.week ?? 0);
  const review = reviews.find((r) => r.week === reviewWeek) ?? reviews[0];
  const showSkips = param(sp, "skips") === "1";
  const log = trades.filter((t) => showSkips || t.action !== "Skipped").slice(0, 150);
  const openLessons = lessons.filter((l) => l.status === "proposed");

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

      {review && (
        <Section
          id="review"
          title={`Week ${review.week} review`}
          note="Every trade that finished that week, on both sides, scored the same way: net premium, less how far the stock ended past the strike when assigned. Early closes are checked against what holding to expiry would have done."
        >
          {reviews.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {reviews.map((r) => (
                <Link key={r.week} href={`/race?review=${r.week}#review`} className={`pill ${r.week === review.week ? "bg-accent/15 text-accent" : "bg-foreground/10 text-muted"}`}>
                  Week {r.week}
                </Link>
              ))}
            </div>
          )}
          <ReviewCard r={review} />
        </Section>
      )}

      <Section id="lessons" title="Lessons and proposed rules" note="What the reviews say to keep, steal or fix. Proposals only: a rule changes when Kyle adopts it in RULES.md.">
        {openLessons.length ? (
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th>For</th>
                  <th>Kind</th>
                  <th>Lesson</th>
                </tr>
              </thead>
              <tbody>
                {openLessons.map((l) => (
                  <tr key={l.id}>
                    <td>{l.week}</td>
                    <td>{l.side === "ai" ? "AI" : l.side === "kyle" ? "Kyle" : "Both"}</td>
                    <td>
                      <span className={`pill ${l.kind === "rule" ? "bg-accent/15 text-accent" : "bg-foreground/10 text-muted"}`}>{l.kind}</span>
                    </td>
                    <td className="whitespace-normal">{l.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">None yet. The first ones come with the next Friday review.</p>
        )}
      </Section>

      <Section id="positions" title="AI open positions" note="Short puts show their collateral (strike × 100), which counts toward exposure as if assigned. Shares came from assignments and are marked at the last price.">
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Symbol</th>
                <th>Theme</th>
                <th className="num">Qty</th>
                <th className="num">Strike or cost</th>
                <th>Expires</th>
                <th className="num">Sold at or mark</th>
                <th className="num">Value or collateral</th>
              </tr>
            </thead>
            <tbody>
              {(state?.options ?? []).map((o) => (
                <tr key={o.id}>
                  <td>Short {o.type}</td>
                  <td>{o.symbol}</td>
                  <td>{o.theme}</td>
                  <td className="num">{o.contracts}</td>
                  <td className="num">{px(o.strike)}</td>
                  <td>{dayLabel(o.expiration)}</td>
                  <td className="num">{px(o.price)}</td>
                  <td className="num">{o.type === "put" ? usd(o.strike * 100 * o.contracts) : "—"}</td>
                </tr>
              ))}
              {(state?.lots ?? []).map((l) => (
                <tr key={l.id}>
                  <td>Shares</td>
                  <td>{l.symbol}</td>
                  <td>{l.theme}</td>
                  <td className="num">{l.shares}</td>
                  <td className="num">{px(l.cost)}</td>
                  <td>—</td>
                  <td className="num">{px(l.mark)}</td>
                  <td className="num">{usd(l.shares * l.mark)}</td>
                </tr>
              ))}
              <tr>
                <td>Cash</td>
                <td colSpan={6} className="text-muted">
                  goes below zero when assigned shares are bought on margin
                </td>
                <td className={`num ${tone(state?.cash)}`}>{usd(state?.cash)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="weeks" title="Week by week">
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Week</th>
                <th>Date</th>
                <th className="num">AI value</th>
                <th className="num">AI week</th>
                <th className="num">AI total</th>
                <th className="num">Kyle week</th>
                <th className="num">Kyle total</th>
                <th className="num">AI premium</th>
                <th className="num">AI exposure</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {[...weeks].reverse().map((w) => (
                <tr key={w.week}>
                  <td>{w.week === 0 ? "Start" : w.label}</td>
                  <td>{dayLabel(w.date)}</td>
                  <td className="num">{usd(w.ai_value)}</td>
                  <td className={`num ${tone(w.ai_week_return)}`}>{spct(w.ai_week_return)}</td>
                  <td className={`num ${tone(w.ai_return)}`}>{spct(w.ai_return)}</td>
                  <td className={`num ${tone(w.opp_week_return)}`}>{spct(w.opp_week_return)}</td>
                  <td className={`num ${tone(w.opp_return)}`}>{spct(w.opp_return)}</td>
                  <td className="num">{usd(w.premium)}</td>
                  <td className="num">{w.leverage ? `${w.leverage.toFixed(2)}x` : "—"}</td>
                  <td className="max-w-md whitespace-normal text-xs text-muted">{w.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        id="trades"
        title="AI trade log"
        note={
          <>
            Every paper sale, buyback, expiry, assignment, call-away and stop, newest first.{" "}
            <Link href={showSkips ? "/race#trades" : "/race?skips=1#trades"} className="text-accent hover:underline">
              {showSkips ? "Hide" : "Show"} the picks the rules skipped
            </Link>
            .
          </>
        }
      >
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th>Symbol</th>
                <th className="num">Strike</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Cash</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {log.map((t) => (
                <tr key={t.id}>
                  <td>{dayLabel(t.date)}</td>
                  <td>
                    <span className={`pill ${ACTION_CLS[t.action] ?? ""}`}>{t.action}</span>
                  </td>
                  <td>
                    {t.symbol} <span className="text-xs text-muted">{t.type}</span>
                  </td>
                  <td className="num">{px(t.strike)}</td>
                  <td className="num">{px(t.qty)}</td>
                  <td className="num">{px(t.price)}</td>
                  <td className={`num ${tone(t.cash)}`}>{t.cash ? usd(t.cash) : ""}</td>
                  <td className="max-w-xl whitespace-normal text-xs text-muted">{t.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="playbook" title="The AI's playbook" note="The full ruleset applies (docs/RULES.md). These are the AI's own choices where Kyle's habits are a choice, not a rule (section 10).">
        <div className="card grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
          <div>
            Exposure: {AI.exposure.monday}x after Monday, up to {AI.exposure.wednesday}x after Wednesday, ceiling {AI.exposure.ceiling}x
          </div>
          <div>
            Size: {pctU(AI.perTicker, 0)} per ticker (one contract up to {pctU(AI.oneContract, 0)}), {pctU(AI.perTheme, 0)} per theme
          </div>
          <div>
            Strike: {AI.strike.moves} expected move below the price; {AI.strike.aggressiveMoves} for scores of {AI.strike.aggressiveMinScore}+ in a Leading group
          </div>
          <div>Premium: at least {pctU(AI.minWeekly, 2)} of the strike for the week</div>
          <div>Fills: mid ∓ {pctU(AI.fillSpreadShare, 0)} of the spread</div>
          <div>Wednesday: buy back at {pctU(AI.takeProfit, 0)} captured or a close below the floor, then redeploy</div>
          <div>Shares: sold on a close below the floor; covered calls at or above cost and one expected move</div>
          <div>Runs: Monday 7:00, Wednesday 7:00, Friday 1:15 Pacific</div>
        </div>
      </Section>
    </div>
  );
}
