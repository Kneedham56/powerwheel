/**
 * Long-option study: what does buying the weekly call or put pay? For every big-enough name with weeklies, every
 * Monday, the call and the put expiring that Friday at three strikes (at the money, |delta| ≈ 0.3 out of the money,
 * |delta| ≈ 0.7 in the money), bought at Monday's close (mid + ¼ spread), and what each was worth on Wednesday (sold at
 * mid − ¼ spread) and at Friday's close (intrinsic value). Plus the name's features as of Friday's close, and the
 * Sunday report's score when the name is a candidate.
 *
 *   npm run skynet -- longs-study --ruleset azir [--from 2018-01-01] [--to 2025-12-31] [--symbols ...]
 *
 * Writes data/skynet/longs-<ruleset>.jsonl, one row per name per week. Research only.
 */
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { spreadOf } from "../src/lib/race";
import { FUNDS, midOf, type Bar, type OptionQuote } from "../src/lib/rules";
import { opt, setup } from "./backtest";
import { ranked } from "./engine";
import { addDays, DATA_DIR } from "./feed";
import { holdFeatures } from "./hold";
import { quoteOrParity } from "./longs";
import { buildCandidates, realMarket, stage, targetExpiry, techAt, type CandidateMeta } from "./logic";
import { getRuleset, withOverrides } from "./rulesets";
import { loadSectors } from "./sectors";

const argv = process.argv.slice(3);
const r4 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 1e4) / 1e4);

/** The contract for a strike choice: ATM = nearest the spot; otm/itm = nearest the |delta| target on that side. */
function pick(book: OptionQuote[], type: "call" | "put", spot: number, how: "atm" | "otm" | "itm", ok: (q: OptionQuote) => boolean) {
  const live = book.filter(ok);
  if (!live.length) return null;
  if (how === "atm") return live.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
  const side = live.filter((q) => q.delta !== null && (how === "otm" ? (type === "call" ? q.strike > spot : q.strike < spot) : type === "call" ? q.strike < spot : q.strike > spot));
  const want = how === "otm" ? 0.3 : 0.7;
  if (!side.length) return null;
  return side.reduce((a, b) => (Math.abs(Math.abs(b.delta!) - want) < Math.abs(Math.abs(a.delta!) - want) ? b : a));
}

export async function longsStudyCmd() {
  const sets = argv.flatMap((a, i) => (a === "--set" ? argv[i + 1].split(",") : []));
  const rs = withOverrides(getRuleset(opt("ruleset", "azir")!), sets, opt("name"));
  const { feed, o } = await setup("2018-01-01", "2025-12-31");
  const tradable = o.symbols;
  const funds = Object.keys(FUNDS);
  const stocks = tradable.filter((s) => !FUNDS[s] && s !== "SPY");
  const sectors = loadSectors();
  const weeks = feed.weeks(addDays(o.from, -10), o.to);
  const first = weeks.findIndex((w) => w.entry >= o.from);
  await feed.loadIv(tradable, feed.weeks(addDays(o.from, -380), o.to).map((w) => w.last));
  const file = join(DATA_DIR, "skynet", `longs-${rs.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jsonl`);
  const out = createWriteStream(file);
  const maxDays = rs.rules.pick.minExpiryDays + 11;
  const fee = o.fees;
  let loadedYear = "";
  let n = 0;
  for (let i = first; i < weeks.length; i++) {
    const w = weeks[i];
    const prev = weeks[i - 1];
    const year = w.entry.slice(0, 4);
    if (year !== loadedYear) {
      const days = new Set<string>();
      for (let j = first; j < weeks.length; j++) {
        if (weeks[j].entry.slice(0, 4) !== year) continue;
        days.add(weeks[j - 1].last);
        days.add(weeks[j].entry);
        days.add(weeks[j].mid);
      }
      feed.dropChainsBefore(prev.last);
      process.stdout.write(`  ${year}: loading chains... `);
      await feed.loadChains(tradable, [...days], maxDays);
      console.log(`${n} rows so far`);
      loadedYear = year;
    }
    if (w.mid === w.entry || w.mid === w.last) continue; // short weeks: no Wednesday
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
    const sunExp = targetExpiry(rs.rules, runDate);
    const quotes: Record<string, OptionQuote[]> = {};
    for (const s of tradable) if (feed.chain(s, prev.last).length) quotes[s] = feed.book(s, prev.last, "put", sunExp);
    const cands = buildCandidates(rs.rules, { runDate, bars, meta, watchlist: [], scanSymbols: stocks, quotes, vix: feed.vixUpTo(prev.last) }, rs.levers?.prep).candidates.filter((c) => tradable.includes(c.symbol));
    const rank = new Map(ranked(rs, cands).map((c, k) => [c.symbol, k]));
    const cand = new Map(cands.map((c) => [c.symbol, c]));

    const spyB = bars.SPY;
    const spyT = spyB ? techAt(rs.rules, spyB) : null;
    const vix = feed.asOf(feed.vix, prev.last);
    const exp = targetExpiry(rs.rules, w.entry);
    if (exp !== w.last) continue; // holiday weeks sell 2-week options; the study keeps to Monday → Friday
    const spyRet = (feed.close("SPY", w.last) ?? NaN) / (feed.close("SPY", w.entry) ?? NaN) - 1;

    for (const s of tradable) {
      const m = meta[s];
      if (!m?.bigEnough || !m.weeklies || !bars[s] || bars[s].length < 60) continue;
      const spot = feed.close(s, w.entry);
      const end = feed.close(s, w.last);
      const wedSpot = feed.close(s, w.mid);
      if (!spot || !end) continue;
      const f0 = feed.splitFactor(s, w.entry);
      const f1 = feed.splitFactor(s, w.last);
      if (f0 === null || f1 === null || Math.abs(f1 / f0 - 1) > 0.01) continue; // a split inside the week
      const t = techAt(rs.rules, bars[s]);
      if (!t) continue;
      const hf = holdFeatures(s, bars[s], spyB, w.entry);
      const spy4 = spyT?.ret4w ?? null;
      const spy13 = spyT?.ret13w ?? null;
      const rs4 = t.ret4w !== null && spy4 !== null ? t.ret4w - spy4 : null;
      const rs13 = t.ret13w !== null && spy13 !== null ? t.ret13w - spy13 : null;
      const c = cand.get(s);
      const row: Record<string, unknown> = {
        date: w.entry,
        symbol: s,
        fund: !!FUNDS[s],
        stage: stage(rs.rules, rs4, rs13, t),
        cand: !!c,
        rank: rank.get(s) ?? null,
        score: c?.score ?? null,
        eligible: c?.eligible ?? null,
        ret1w: r4(t.ret1w),
        ret4w: r4(t.ret4w),
        ret13w: r4(t.ret13w),
        mom12: r4(hf.mom12),
        smooth: r4(hf.smooth),
        rs4: r4(rs4),
        rs13: r4(rs13),
        vs50: r4(t.vs50),
        vs200: r4(t.vs200),
        pctB: r4(t.pctB),
        rsi: r4(t.rsi14),
        offHigh: r4(t.offHigh),
        rv20: r4(t.realizedVol),
        vol: r4(hf.vol),
        iv: r4(m.iv),
        ivRank: r4(m.ivRank),
        term: r4(m.termRatio),
        spyVs200: r4(spyT?.vs200),
        spyRet4w: r4(spy4),
        vix,
        stock: r4(end / spot - 1),
        stockWed: wedSpot ? r4(wedSpot / spot - 1) : null,
        spy: r4(spyRet),
      };
      const monChain = { call: feed.book(s, w.entry, "call", exp), put: feed.book(s, w.entry, "put", exp) };
      const wedChain = { call: feed.book(s, w.mid, "call", exp), put: feed.book(s, w.mid, "put", exp) };
      for (const type of ["call", "put"] as const) {
        for (const how of ["atm", "otm", "itm"] as const) {
          const q = pick(monChain[type], type, spot, how, (x) => realMarket(rs.rules, x));
          if (!q) continue;
          const cost = midOf(q)! + rs.ai.fillSpreadShare * spreadOf(q);
          if (cost < 0.05) continue;
          const intrinsic = type === "call" ? Math.max(0, end - q.strike) : Math.max(0, q.strike - end);
          const wq = quoteOrParity(wedChain.call, wedChain.put, type, q.strike, wedSpot);
          const wm = wq ? midOf(wq) : null;
          const wedSell = wq && wm !== null && wq.bid ? Math.max(wq.bid, wm - rs.ai.fillSpreadShare * spreadOf(wq)) : null;
          const k = `${type[0]}${how}`;
          row[`${k}_k`] = q.strike;
          row[`${k}_px`] = r4(cost);
          row[`${k}_d`] = r4(q.delta);
          row[`${k}_iv`] = r4(q.iv);
          row[`${k}_spr`] = r4(spreadOf(q) / midOf(q)!);
          // returns per $ of premium, net of $fee a contract each way (none on an expiry worth nothing)
          row[`${k}_fri`] = r4((intrinsic - cost - (fee + (intrinsic > 0 ? fee : 0)) / 100) / cost);
          row[`${k}_wed`] = wedSell !== null ? r4((wedSell - cost - (2 * fee) / 100) / cost) : null;
        }
      }
      out.write(JSON.stringify(row) + "\n");
      n++;
    }
  }
  out.end();
  console.log(`Wrote ${n} rows to ${file}`);
}
