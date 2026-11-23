/**
 * Pick study: how good is the Sunday report's ranking? For every eligible candidate on every Sunday, the put the
 * engine would sell on Monday (aiTarget strike, real market, minWeekly) and what happened to it.
 *
 *   npm run skynet -- picks --ruleset nasus [--from 2018-01-01] [--to 2025-12-31] [--symbols ...] [--set ...]
 *
 * Writes data/skynet/picks-<ruleset>.jsonl, one row per candidate per week: the report's fields, extra features from
 * the bars, the Monday put, and the outcome (expiry close, assignment, the stock 4 and 13 weeks later). Research
 * only: nothing reads it but the analysis scripts.
 */
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { r2, spreadOf } from "../src/lib/race";
import { FUNDS, midOf, type Bar, type OptionQuote } from "../src/lib/rules";
import { opt, setup } from "./backtest";
import { aiTarget, ranked, regimeScale } from "./engine";
import { addDays, DATA_DIR } from "./feed";
import { buildCandidates, realMarket, regimeFeatures, targetExpiry, type CandidateMeta } from "./logic";
import { getRuleset, withOverrides } from "./rulesets";
import { loadSectors } from "./sectors";

const argv = process.argv.slice(3);

const retN = (c: number[], n: number) => (c.length > n && c[c.length - 1 - n] ? c[c.length - 1] / c[c.length - 1 - n] - 1 : null);
function vol(c: number[], n: number) {
  if (c.length <= n) return null;
  const lr = c.slice(-n - 1).slice(1).map((x, i) => Math.log(x / c[c.length - n - 1 + i]));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  return Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / lr.length) * Math.sqrt(252);
}
/** worst 5-day return in the last n days */
function worstWeek(c: number[], n: number) {
  let w = 0;
  for (let i = Math.max(5, c.length - n); i < c.length; i++) w = Math.min(w, c[i] / c[i - 5] - 1);
  return w;
}

export async function picksCmd() {
  const sets = argv.flatMap((a, i) => (a === "--set" ? argv[i + 1].split(",") : []));
  const rs = withOverrides(getRuleset(opt("ruleset", "nasus")!), sets, opt("name"));
  const { feed, o } = await setup("2018-01-01", "2025-12-31");
  const tradable = o.symbols;
  const funds = Object.keys(FUNDS);
  const stocks = tradable.filter((s) => !FUNDS[s] && s !== "SPY");
  const sectors = loadSectors();
  const weeks = feed.weeks(addDays(o.from, -10), addDays(o.to, 120));
  const first = weeks.findIndex((w) => w.entry >= o.from);
  const lastI = weeks.findLastIndex((w) => w.last <= o.to);
  await feed.loadIv(tradable, feed.weeks(addDays(o.from, -380), o.to).map((w) => w.last));
  const file = join(DATA_DIR, "skynet", `picks-${rs.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jsonl`);
  const out = createWriteStream(file);
  const maxDays = rs.rules.pick.minExpiryDays + 11;
  let loadedYear = "";
  let n = 0;
  for (let i = first; i <= lastI; i++) {
    const w = weeks[i];
    const prev = weeks[i - 1];
    const year = w.entry.slice(0, 4);
    if (year !== loadedYear) {
      const days = new Set<string>();
      for (let j = first; j <= lastI; j++) {
        if (weeks[j].entry.slice(0, 4) !== year) continue;
        days.add(weeks[j - 1].last);
        days.add(weeks[j].entry);
      }
      feed.dropChainsBefore(prev.last);
      process.stdout.write(`  ${year}: loading chains... `);
      await feed.loadChains(tradable, [...days], maxDays);
      console.log(`${n} rows so far`);
      loadedYear = year;
    }
    const runDate = addDays(w.monday, -1);
    const bars: Record<string, Bar[]> = {};
    for (const s of new Set(["SPY", ...funds, ...tradable])) {
      const b = feed.barsAsOf(s, w.entry, { strict: true });
      if (b && b.length >= 2) bars[s] = b;
    }
    const meta: Record<string, CandidateMeta> = {};
    for (const s of tradable) {
      const ch = feed.chain(s, prev.last);
      const exps = new Set(ch.map((c) => c.expiry).filter((e) => e > prev.last));
      const dv = feed.dollarVolume(s, w.entry);
      meta[s] = { sector: sectors[s], bigEnough: !!FUNDS[s] || (dv !== null && dv >= o.minDollarVolume), ...feed.ivOn(s, prev.last), weeklies: exps.size >= 2, termRatio: feed.termRatio(s, prev.last) };
    }
    const expiry = targetExpiry(rs.rules, runDate);
    const quotes: Record<string, OptionQuote[]> = {};
    for (const s of tradable) if (feed.chain(s, prev.last).length) quotes[s] = feed.book(s, prev.last, "put", expiry);
    const cands = buildCandidates(rs.rules, { runDate, bars, meta, watchlist: [], scanSymbols: stocks, quotes }, rs.levers?.prep).candidates.filter((c) => tradable.includes(c.symbol));

    const spyC = (feed.barsAsOf("SPY", w.entry, { strict: true, n: 250 }) ?? []).map((b) => b.close);
    const riskOn = regimeScale(rs, { spy: spyC, vix: null, px: {} }) >= 1;
    const monExp = targetExpiry(rs.rules, w.entry);
    const w4 = weeks[i + 4]?.last;
    const w13 = weeks[i + 13]?.last;
    for (const [rank, c] of ranked(rs, cands).entries()) {
      const book = feed.book(c.symbol, w.entry, "put", monExp);
      const spot = feed.close(c.symbol, w.entry) ?? c.last;
      const target = aiTarget(rs, c);
      const q = book
        .filter((x) => x.strike <= target + 1e-9 && realMarket(rs.rules, x) && (midOf(x)! / x.strike) >= rs.ai.minWeekly)
        .sort((a, b) => b.strike - a.strike)[0];
      const cl = bars[c.symbol].map((b) => b.close);
      const row: Record<string, unknown> = {
        date: w.entry,
        symbol: c.symbol,
        rank,
        risk_on: riskOn,
        score: c.score,
        parts: c.parts,
        stage: c.stage,
        put_call: c.put_call,
        theme: c.theme,
        fund: !!FUNDS[c.symbol],
        quad: c.group_quadrant,
        rs4: c.rs4,
        rs13: c.rs13,
        vs50: c.vs50,
        vs200: c.vs200,
        pct_b: c.pct_b,
        rsi: c.rsi,
        iv: c.iv,
        iv_rank: c.iv_rank,
        move: c.exp_move !== null ? c.exp_move / c.last : null,
        ret1w: c.week,
        ret6m: retN(cl, 126),
        ret12m: retN(cl, 252),
        rv20: vol(cl, 20),
        rv60: vol(cl, 60),
        worst60: worstWeek(cl, 60),
        off_high: Math.max(...bars[c.symbol].slice(-252).map((b) => b.high)) ? c.last / Math.max(...bars[c.symbol].slice(-252).map((b) => b.high)) - 1 : null,
        to_floor: c.floor ? c.last / c.floor - 1 : null,
        dv: feed.dollarVolume(c.symbol, w.entry),
        price: spot,
        term: meta[c.symbol]?.termRatio ?? null,
      };
      if (q) {
        const prem = r2(midOf(q)! - rs.ai.fillSpreadShare * spreadOf(q));
        const end = feed.close(c.symbol, q.expiry) ?? feed.close(c.symbol, w.last);
        const c4 = w4 ? feed.close(c.symbol, w4) : undefined;
        const c13 = w13 ? feed.close(c.symbol, w13) : undefined;
        Object.assign(row, {
          strike: q.strike,
          prem,
          weekly: prem / q.strike,
          otm: 1 - q.strike / spot,
          delta: q.delta,
          spread: spreadOf(q) / midOf(q)!,
          end,
          assigned: end !== undefined ? end < q.strike : null,
          put_pnl: end !== undefined ? (prem - Math.max(0, q.strike - end)) / q.strike : null,
          // the put, then the shares held 4 / 13 weeks if assigned (vs the strike; split moves aren't adjusted)
          wheel4: end !== undefined && c4 !== undefined ? (prem + (end < q.strike ? c4 - q.strike : 0)) / q.strike : null,
          wheel13: end !== undefined && c13 !== undefined ? (prem + (end < q.strike ? c13 - q.strike : 0)) / q.strike : null,
          fwd4: c4 !== undefined ? c4 / spot - 1 : null,
        });
      }
      out.write(JSON.stringify(row) + "\n");
      n++;
    }
  }
  out.end();
  console.log(`Wrote ${n} rows to ${file}`);
}

/**
 * Regime study: the adaptive report's regime features for every Sunday (bars through Friday only), in a few
 * parameter settings, for the pick study's switch rules (data/skynet/tools/switch.js).
 *
 *   npm run skynet -- regime [--from 2018-01-01] [--to 2025-12-31] [--symbols ...]
 *
 * Writes data/skynet/regime.jsonl: one row per week, keyed by the Monday entry date like the pick file.
 */
export async function regimeCmd() {
  const { feed, o } = await setup("2018-01-01", "2025-12-31");
  const stocks = o.symbols.filter((s) => !FUNDS[s] && s !== "SPY");
  const weeks = feed.weeks(addDays(o.from, -10), o.to);
  const first = weeks.findIndex((w) => w.entry >= o.from);
  const file = join(DATA_DIR, "skynet", "regime.jsonl");
  const out = createWriteStream(file);
  const variants: Record<string, Parameters<typeof regimeFeatures>[3]> = {
    "": {},
    m8: { mom: { weeks: 8 } },
    h2: { mom: { horizon: 2 } },
    t5: { mom: { top: 0.2 } },
    c13: { crash: { weeks: 13 } },
    c26: { crash: { weeks: 26 } },
  };
  let n = 0;
  for (let i = first; i < weeks.length; i++) {
    const w = weeks[i];
    const prev = weeks[i - 1];
    const bars: Record<string, Bar[]> = {};
    for (const s of ["SPY", ...stocks]) {
      const b = feed.barsAsOf(s, w.entry, { strict: true });
      if (b && b.length >= 2) bars[s] = b;
    }
    const vix = feed.vixUpTo(prev.last);
    const row: Record<string, unknown> = { date: w.entry };
    for (const [tag, A] of Object.entries(variants)) {
      const f = regimeFeatures(bars, stocks, vix, A);
      if (!tag) Object.assign(row, f);
      else if (tag.startsWith("c")) Object.assign(row, { [`crash_${tag}`]: f.crash, [`crashDrop_${tag}`]: f.crashDrop, [`crashBounce_${tag}`]: f.crashBounce });
      else Object.assign(row, { [`mom_${tag}`]: f.mom, [`momHit_${tag}`]: f.momHit });
    }
    out.write(JSON.stringify(row) + "\n");
    n++;
  }
  out.end();
  console.log(`Wrote ${n} weeks to ${file}`);
}
