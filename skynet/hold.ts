/**
 * Buy and hold for Skynet rulesets (levers.hold): put the cash into the best names and keep them, selling one only
 * when the money is wanted for a better opportunity.
 *
 * Every week the names are ranked on bars through Friday's close (no look-ahead) and the book acts at Monday's close:
 *  - the first week, and on each review week after (weekly, monthly or quarterly), it fills empty slots from the top
 *    of the ranking, `maxNames` names in all, each bought with an equal share of the money it has
 *  - on a review week, a holding that has fallen out of the top `keep` is sold, and its money goes to the best name
 *    not held. That is the only sell: no stop, no target, no trimming of winners, no regime exit unless `regime` says so
 *  - a held name that stops trading (delisted, bought out) is sold at its last price
 *
 * The book's size is `exposure` × the account value (1 = all the cash). Alone ("only") it is the whole account.
 * Beside the wheel ("add") its lots don't count toward the wheel's exposure targets, only toward the account's margin
 * cap, so with exposure 1 the wheel's puts get the margin above 1x. Hold lots carry the theme "hold": no covered calls,
 * no floor stop, no downtrend sale, and they don't use the wheel's theme caps. Pure functions only.
 */
import { accountValue, exposure, r2, type Action, type Lot, type RaceState, type Trade } from "../src/lib/race";
import type { Bar } from "../src/lib/rules";
import type { Ruleset } from "./rulesets";

export interface HoldLevers {
  /** "only": buy and hold alone (no options). "add": beside the wheel, which gets the margin above the book. */
  mode: "only" | "add";
  /** the book's size, a multiple of the account value (1 = all the cash) */
  exposure: number;
  /** how many names the book holds */
  maxNames: number;
  /** a holding is sold (on a review week) once it ranks below this; default 3 × maxNames. Infinity = never sold */
  keep?: number;
  /** how often it looks for better names and fills empty slots (default "monthly": the first week of each month) */
  review?: "weekly" | "monthly" | "quarterly" | "yearly";
  /**
   * the ranking, best first (a feature from holdFeatures; "-x" = lowest first). Default "mom12".
   * A list blends ranks: each name's average rank across the features.
   */
  rank?: string | string[];
  /** a name qualifies only when each feature is within [min, max] (null = no bound; a missing feature fails) */
  filters?: Record<string, [number | null, number | null]>;
  /** which names: "all" (stocks and funds), "stocks", "funds", or a fixed list */
  universe?: "all" | "stocks" | "funds" | string[];
  /** leave out leveraged and inverse ETFs (default true) */
  noLeveraged?: boolean;
  /** only names passing the report's size test (20-day dollar volume, default true; funds always pass) */
  bigOnly?: boolean;
  /**
   * only names with weekly options that week (default false). The stock list is every name that ever had weeklies
   * (2012–2026, delisted ones included), so this makes it point-in-time: a name that only got weeklies later, once it
   * was already a winner, can't be bought before then. Like bigOnly, a holding that stops qualifying can be sold on a
   * review week.
   */
  weekliesNow?: boolean;
  /** only the N names with the most 20-day dollar volume that week (point-in-time size; funds always pass) */
  topVolume?: number;
  /** the ruleset's regime gate (levers.spyMaDays, vixMax): when risk-off on a Monday, sell the book; buy back when risk-on */
  regime?: boolean;
  /** cost of each share fill, as a share of the price (default 0.0005) */
  slip?: number;
  /** "equal" (default): each new name gets an equal share. "rank": the best-ranked get more (weights N, N−1, …, 1) */
  weight?: "equal" | "rank";
  /** spare money under this share of the account isn't put to work (default 0.02) */
  minTrade?: number;
}

/** What Monday gives the book: features for every name (bars through Friday), and Monday's closes. */
export interface HoldInput {
  /** features by symbol, from holdFeatures */
  feats: Record<string, HoldFeatures>;
  /** Monday's close by symbol */
  px: Record<string, number>;
  /** symbols that are funds (for the universe lever) */
  funds: string[];
  /** names passing the size test */
  big: string[];
  /** names with weekly options this week (2+ expiries in the next 15 days) */
  weeklies?: string[];
  /** 20-day dollar volume by symbol, as of Monday */
  dv?: Record<string, number>;
  /** held names with no bar in the last 10 days (no longer trading) */
  stale: string[];
  /** the ruleset's regime gate as of the close before */
  riskOn: boolean;
  /** first week of the run */
  first: boolean;
  /** is this a review week for `review` */
  reviews: { weekly: boolean; monthly: boolean; quarterly: boolean; yearly: boolean };
}

export interface HoldLedger {
  id(prefix: string): string;
  add(action: Action, t: Partial<Omit<Trade, "id" | "date" | "week" | "action" | "rules_version">>): Trade;
}

export const HOLD = "hold";
export const holdOf = (rs: Ruleset) => rs.levers?.hold;
export const isHoldLot = (l: Lot) => l.theme === HOLD;

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;

export type HoldFeatures = Record<string, number | null>;

/** a placebo in [0, 1) from a string: no market information */
function hash01(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1e6) / 1e6;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/**
 * Ranking features from daily bars through Friday's close. Returns are on closes (split-adjusted):
 *  mom12  12-month return skipping the last month (t−252 → t−21), the classic momentum factor
 *  mom6   6-month return skipping the last month (t−126 → t−21)
 *  ret12, ret6, ret3  plain 12, 6 and 3-month returns
 *  vs200  close ÷ 200-day average − 1;  offHigh  close ÷ 52-week high − 1
 *  rs13   13-week return minus SPY's
 *  vol    annualised stdev of daily returns over the last year (lowvol ranks = "-vol")
 *  sharpe12  ret12 ÷ vol;  smooth  share of up weeks in the last year (steady climbers)
 *  dd12   worst drawdown in the last year (≤ 0)
 *  price, days (bars available)
 *  rand   a placebo that changes every week;  fixed  a placebo per name that never changes
 */
export function holdFeatures(sym: string, bars: Bar[], spy: Bar[] | undefined, date: string): HoldFeatures {
  const c = bars.map((b) => b.close);
  const n = c.length;
  const last = c[n - 1];
  const at = (k: number) => (n - 1 - k >= 0 ? c[n - 1 - k] : null);
  const r = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b - 1 : null);
  const yr = c.slice(-253);
  const daily = yr.slice(1).map((x, i) => x / yr[i] - 1);
  const vol = daily.length >= 120 ? sd(daily) * Math.sqrt(252) : null;
  const ret12 = r(last, at(252));
  let peak = 0;
  let dd = 0;
  for (const x of yr) {
    peak = Math.max(peak, x);
    dd = Math.min(dd, x / peak - 1);
  }
  const wk = yr.filter((_, i) => (yr.length - 1 - i) % 5 === 0);
  const ups = wk.slice(1).filter((x, i) => x > wk[i]).length;
  const s200 = n >= 200 ? mean(c.slice(-200)) : null;
  const spyC = spy?.map((b) => b.close) ?? [];
  const spy13 = spyC.length > 63 ? spyC[spyC.length - 1] / spyC[spyC.length - 64] - 1 : null;
  const ret3 = r(last, at(63));
  return {
    mom12: r(at(21), at(252)),
    mom6: r(at(21), at(126)),
    ret12,
    ret6: r(last, at(126)),
    ret3,
    vs200: s200 ? last / s200 - 1 : null,
    offHigh: yr.length >= 200 ? last / Math.max(...yr) - 1 : null,
    rs13: ret3 !== null && spy13 !== null ? ret3 - spy13 : null,
    vol,
    sharpe12: ret12 !== null && vol ? ret12 / vol : null,
    smooth: wk.length >= 40 ? ups / (wk.length - 1) : null,
    dd12: yr.length >= 200 ? dd : null,
    price: last,
    days: n,
    rand: hash01(`${sym}|${date}`),
    fixed: hash01(sym),
  };
}

/** The book's ranking this week, best first: the symbols that qualify. */
export function holdRanking(H: HoldLevers, inp: HoldInput, leveraged: Set<string>): string[] {
  const funds = new Set(inp.funds);
  const big = new Set(inp.big);
  const weeklies = new Set(inp.weeklies ?? []);
  const dv = inp.dv ?? {};
  const topVol = H.topVolume ? new Set(Object.keys(dv).filter((x) => !funds.has(x)).sort((a, b) => dv[b] - dv[a]).slice(0, H.topVolume)) : null;
  const u = H.universe ?? "all";
  const keys = (Array.isArray(H.rank) ? H.rank : [H.rank ?? "mom12"]).map((k) => ({ k: k.replace(/^-/, ""), low: k.startsWith("-") }));
  const pool = Object.entries(inp.feats).filter(([sym, f]) => {
    if (sym === "SPY" && u !== "all" && !Array.isArray(u)) return false;
    if (Array.isArray(u) ? !u.includes(sym) : u === "stocks" ? funds.has(sym) : u === "funds" ? !funds.has(sym) : false) return false;
    if ((H.noLeveraged ?? true) && leveraged.has(sym)) return false;
    if ((H.bigOnly ?? true) && !funds.has(sym) && !big.has(sym) && !Array.isArray(u)) return false;
    if (H.weekliesNow && !funds.has(sym) && !weeklies.has(sym)) return false;
    if (topVol && !funds.has(sym) && !topVol.has(sym)) return false;
    if (inp.px[sym] === undefined) return false;
    if (keys.some(({ k }) => f[k] === null || f[k] === undefined)) return false;
    return !H.filters || Object.entries(H.filters).every(([k, [lo, hi]]) => typeof f[k] === "number" && (lo === null || f[k]! >= lo) && (hi === null || f[k]! <= hi));
  });
  if (keys.length === 1) {
    const { k, low } = keys[0];
    return pool.sort((a, b) => (low ? a[1][k]! - b[1][k]! : b[1][k]! - a[1][k]!)).map(([s]) => s);
  }
  const avg = new Map<string, number>();
  for (const { k, low } of keys) {
    const order = [...pool].sort((a, b) => (low ? a[1][k]! - b[1][k]! : b[1][k]! - a[1][k]!));
    order.forEach(([s], i) => avg.set(s, (avg.get(s) ?? 0) + i / keys.length));
  }
  return pool.map(([s]) => s).sort((a, b) => avg.get(a)! - avg.get(b)!);
}

function sellLot(H: HoldLevers, s: RaceState, L: HoldLedger, l: Lot, px: number, why: string) {
  const fill = px * (1 - (H.slip ?? 0.0005));
  s.cash += fill * l.shares;
  s.lots = s.lots.filter((x) => x.id !== l.id);
  const pnl = (fill - l.cost) * l.shares;
  L.add("Sold shares", { symbol: l.symbol, type: "shares", qty: l.shares, price: r2(fill), cash: fill * l.shares, position_id: l.id, note: `Hold: ${why}. ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))} (${pct(fill / l.cost - 1)}) vs the ${r2(l.cost)} cost, held since ${l.opened}` });
}

/**
 * Monday's book step, at the close. In "add" mode it runs before the wheel's puts, so the book takes the cash and the
 * wheel the margin above it.
 */
export function holdStep(rs: Ruleset, maxLeverage: number, s: RaceState, L: HoldLedger, date: string, inp: HoldInput | undefined, leveraged: Set<string>) {
  const H = holdOf(rs);
  if (!H || !inp) return;
  const slip = H.slip ?? 0.0005;
  const lots = () => s.lots.filter(isHoldLot);
  for (const l of s.lots) if (inp.px[l.symbol] !== undefined) l.mark = inp.px[l.symbol];

  // names that stopped trading leave at their last price
  for (const l of lots()) if (inp.stale.includes(l.symbol)) sellLot(H, s, L, l, l.mark, "no longer trading; sold at the last price");

  // the regime exit (only when the lever asks for it)
  if (H.regime && !inp.riskOn) {
    for (const l of lots()) sellLot(H, s, L, l, inp.px[l.symbol] ?? l.mark, "risk-off: out until the market's trend turns back up");
    return;
  }

  const review = inp.first || inp.reviews[H.review ?? "monthly"];
  if (!review) return;
  const ranking = holdRanking(H, inp, leveraged);
  const pos = new Map(ranking.map((sym, i) => [sym, i]));
  const keep = H.keep ?? 3 * H.maxNames;

  // sell what has fallen out of the top `keep`, but only if a better name is waiting to take the money
  const heldSyms = new Set(lots().map((l) => l.symbol));
  const waiting = ranking.filter((x) => !heldSyms.has(x)).slice(0, H.maxNames);
  const out = lots()
    .filter((l) => (pos.get(l.symbol) ?? Infinity) >= keep)
    .sort((a, b) => (pos.get(b.symbol) ?? Infinity) - (pos.get(a.symbol) ?? Infinity))
    .slice(0, waiting.length);
  for (const l of out) {
    const rk = pos.get(l.symbol);
    sellLot(H, s, L, l, inp.px[l.symbol] ?? l.mark, rk === undefined ? "no longer qualifies; the money goes to a better name" : `ranked #${rk + 1}, out of the top ${keep}; the money goes to a better name`);
  }

  // fill empty slots from the top, with the book's spare money (its size minus what it holds), inside the margin cap
  const sp = { ...Object.fromEntries(s.lots.map((l) => [l.symbol, l.mark])), ...inp.px };
  const v = accountValue(s, sp);
  const bookNow = lots().reduce((a, l) => a + l.shares * (sp[l.symbol] ?? l.mark), 0);
  let budget = Math.min(H.exposure * v - bookNow, maxLeverage * v - exposure(s, sp));
  if (budget < (H.minTrade ?? 0.02) * v) return;
  const held = new Set(lots().map((l) => l.symbol));
  const buys = ranking.filter((x) => !held.has(x)).slice(0, Math.max(0, H.maxNames - held.size));
  if (!buys.length) {
    // no empty slot: spare money (interest, the wheel's premium) goes to the holdings still in the top maxNames
    const top = lots().filter((l) => (pos.get(l.symbol) ?? Infinity) < H.maxNames);
    for (const l of top) {
      const px = inp.px[l.symbol];
      if (px === undefined) continue;
      const n = Math.floor(budget / top.length / (px * (1 + slip)));
      if (n < 1) continue;
      const fill = px * (1 + slip);
      s.cash -= fill * n;
      Object.assign(l, { cost: (l.cost * l.shares + fill * n) / (l.shares + n), shares: l.shares + n, mark: px });
      L.add("Bought shares" as Action, { symbol: l.symbol, type: "shares", qty: n, price: r2(fill), cash: -fill * n, position_id: l.id, note: `Hold: added spare money to a holding ranked #${pos.get(l.symbol)! + 1}` });
    }
    return;
  }
  const w = buys.map((_, i) => (H.weight === "rank" ? buys.length - i : 1));
  const wsum = w.reduce((a, b) => a + b, 0);
  const slots = H.maxNames - held.size;
  // with more slots than names to buy (a thin ranking), each name still gets one slot's share, not more
  const each = budget / Math.max(slots, buys.length);
  for (const [i, sym] of buys.entries()) {
    const px = inp.px[sym];
    const fill = px * (1 + slip);
    const money = H.weight === "rank" ? (budget * w[i]) / wsum : each;
    const n = Math.floor(Math.min(money, budget) / fill);
    if (n < 1) continue;
    budget -= fill * n;
    s.cash -= fill * n;
    const id = L.id("h");
    s.lots.push({ id, symbol: sym, theme: HOLD, shares: n, cost: fill, mark: px, opened: date });
    L.add("Bought shares" as Action, { symbol: sym, type: "shares", qty: n, price: r2(fill), cash: -fill * n, position_id: id, note: `Hold: ranked #${pos.get(sym)! + 1} by ${Array.isArray(H.rank) ? H.rank.join(" + ") : (H.rank ?? "mom12")}` });
  }
}
