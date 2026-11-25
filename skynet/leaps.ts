/**
 * Long-dated options for Skynet rulesets (levers.leaps), alone ("only") or beside the rest of a ruleset ("add").
 *
 * Four books, any mix:
 * - `calls` / `puts`: buy options months out (LEAPS), hold them for months, sell and reopen ("roll") when few days
 *   are left. Names are ranked like the long-call and hold books (features from bars through Friday's close); on review
 *   weeks a name ranked below `keep` is sold for a better one.
 * - `shortPuts` (the long-dated wheel): sell puts months out; buy back early at a take profit; at expiry in the money
 *   the shares are bought at the strike, then `coveredCalls` sells long-dated calls on them until they're called away.
 * - `shortCalls` (poor man's covered call): against each long call, sell a nearer call above its strike; in the money
 *   at expiry it's closed at intrinsic value (cash, the long call stays).
 *
 * Everything acts Monday at the close (the week's entry day). Friday, what expires settles (long: intrinsic in cash;
 * short put: assignment; short call: called away or closed at intrinsic) and every open position is marked at that
 * day's mid, so the week's account value includes them (`leapsValue`). Fills: buy at mid + the ruleset's fill share of
 * the spread, sell at mid − that share (never below the bid); a per-contract fee on each trade.
 *
 * The positions live in the race state under `leaps` (outside `options` and `lots`, which the wheel reads), shares
 * from an assignment included, so the wheel's covered calls, stops and downtrend sales never touch them. Pure
 * functions only: the backtest loads the chains (feed.leapsChains) and passes them in.
 */
import { r2, spreadOf, type Action, type RaceState, type Trade } from "../src/lib/race";
import { midOf, type OptionQuote } from "../src/lib/rules";
import type { Ruleset } from "./rulesets";

/** A quote with its side (the long-dated chain has both). */
export type LeapQuote = OptionQuote & { right: "call" | "put" };

interface Pick {
  /** most names held */
  maxNames: number;
  /** a name qualifies only when each feature is within [min, max] (null = no bound; a missing feature fails) */
  filters?: Record<string, [number | null, number | null]>;
  /** best first (a feature; "-x" = lowest first). A list averages the ranks. Default "rand" */
  rank?: string | string[];
  /** "big" (default): names with weeklies and the size test that week; "stocks" / "funds"; "report": the Sunday report's eligible names */
  universe?: "big" | "report" | "stocks" | "funds";
  /** a fixed list of names instead (still needs weeklies and the size test) */
  symbols?: string[];
  /** the ruleset's market gate for new positions: "on" only while risk-on, "off" only while risk-off */
  regime?: "on" | "off";
  /** expiry window for a new position, days out [min, max]; picks the expiry nearest `target` (default the middle) */
  dte: [number, number];
  target?: number;
  /** |delta| for the strike (e.g. 0.8 = in the money for a long call) */
  delta: number;
  /** only contracts whose spread is at most this share of the mid (default 0.1) */
  maxSpread?: number;
}

export interface LeapLong extends Pick {
  /**
   * Size of each new position. "delta" (default): delta × shares = `alloc` × account ÷ maxNames (alloc 1 = stock-like
   * 1x exposure); "premium": premium = `alloc` × account ÷ maxNames.
   */
  sizing?: "delta" | "premium";
  alloc: number;
  /** sell (and reopen, if the name still ranks) when this many days or fewer are left */
  rollAt: number;
  /** review weeks: a held name ranked below `keep` (or not ranked at all) is sold for the best one not held */
  review?: "weekly" | "monthly" | "quarterly" | "yearly";
  keep?: number;
  /** Monday: sell a position worth at least (1 + takeProfit) × its cost (it can be reopened next review) */
  takeProfit?: number;
  /** Monday: sell a position worth at most (1 − stopLoss) × its cost */
  stopLoss?: number;
}

export interface LeapShortPut extends Pick {
  /** collateral (strike × 100 × contracts) per name = alloc × account ÷ maxNames */
  alloc: number;
  /** Monday: buy back once the put is worth at most (1 − takeProfit) × what it sold for (0.5 = half the premium kept) */
  takeProfit?: number;
  /** Monday: buy back and sell again when this many days or fewer are left (default: hold to expiry) */
  rollAt?: number;
  /** collateral of the open puts + assigned shares at market, at most this × the account (default 1) */
  maxExposure?: number;
  /** Monday: sell assigned shares (and their call) once they're at most (1 − stop) × their cost (default: hold) */
  stop?: number;
}

export interface LeapCoveredCall {
  /** expiry window and |delta| for calls sold on assigned shares */
  dte: [number, number];
  target?: number;
  delta: number;
  /** never a strike below the shares' cost (default true) */
  aboveCost?: boolean;
  takeProfit?: number;
  maxSpread?: number;
}

export interface LeapShortCall {
  /** expiry window, days out ([0, 7] = this Friday's weekly) */
  dte: [number, number];
  target?: number;
  delta: number;
  /** Monday: buy back once worth at most (1 − takeProfit) × its sale */
  takeProfit?: number;
  maxSpread?: number;
}

export interface LeapLevers {
  /** "only": these books alone. "add": beside the rest of the ruleset (wheel, hold book), sharing the account */
  mode: "only" | "add";
  calls?: LeapLong;
  puts?: LeapLong;
  shortPuts?: LeapShortPut;
  coveredCalls?: LeapCoveredCall;
  shortCalls?: LeapShortCall;
  /** leave out leveraged and inverse ETFs (default true) */
  noLeveraged?: boolean;
}

export interface LeapPos {
  id: string;
  symbol: string;
  /** the book: long call / long put / short put / covered call / short call (against a long call) / shares (assigned) */
  book: "call" | "put" | "shortPut" | "coveredCall" | "shortCall" | "shares";
  right: "call" | "put" | null;
  strike: number;
  expiry: string;
  /** contracts (shares for book "shares") */
  qty: number;
  /** per share: the fill (shares: the strike paid) */
  cost: number;
  /** per share, the last mark */
  mark: number;
  opened: string;
  /** a short call's long call, a covered call's share position */
  link?: string;
}

export type LeapState = RaceState & { leaps?: LeapPos[] };

export const leapsOf = (rs: Ruleset) => rs.levers?.leaps;

const SHORT = new Set<LeapPos["book"]>(["shortPut", "coveredCall", "shortCall"]);
const mult = (p: LeapPos) => (p.book === "shares" ? 1 : 100);

/** Open positions at their marks: long options and shares add, short options subtract. */
export function leapsValue(s: RaceState) {
  return ((s as LeapState).leaps ?? []).reduce((a, p) => a + (SHORT.has(p.book) ? -1 : 1) * p.mark * mult(p) * p.qty, 0);
}

/** Collateral and share value of the long-dated wheel (open short puts at strike, assigned shares at mark). */
function wheelExposure(s: LeapState) {
  return (s.leaps ?? []).reduce((a, p) => a + (p.book === "shortPut" ? p.strike * 100 * p.qty : p.book === "shares" ? p.mark * p.qty : 0), 0);
}

export interface LeapsMondayInput {
  /** features by symbol (longFeatures) for the names that may be traded */
  feats: Record<string, Record<string, number | null>>;
  /** names with weeklies passing the size test this week */
  big: string[];
  funds: string[];
  /** Monday's long-dated chains (every expiry the books' windows and the held positions need), by symbol */
  chains: Record<string, LeapQuote[]>;
  spots: Record<string, number>;
  riskOn: boolean;
  reviews: { weekly: boolean; monthly: boolean; quarterly: boolean; yearly: boolean };
  /** the account value before these books act (the rest of the ruleset at Monday's prices, without the leaps) */
  baseValue: number;
}

export interface LeapsFridayInput {
  /** Friday's chains for the held symbols (their expiries only) */
  chains: Record<string, LeapQuote[]>;
  closes: Record<string, number>;
}

interface Ledger {
  id(prefix: string): string;
  add(action: Action, t: Partial<Omit<Trade, "id" | "date" | "week" | "action" | "rules_version">>): Trade;
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

/**
 * Names in rank order for a book (best first). The same rules as the long-call book: the pool is the week's names
 * with weeklies and the size test, filtered, then sorted by a feature or the average rank of several.
 */
export function rankFor(P: Pick, inp: { feats: LeapsMondayInput["feats"]; big: string[]; funds: string[]; spots: Record<string, number> }, leveraged: Set<string>, noLev: boolean): string[] {
  const funds = new Set(inp.funds);
  const u = P.universe ?? "big";
  const keys = (Array.isArray(P.rank) ? P.rank : [P.rank ?? "rand"]).map((k) => ({ k: k.replace(/^-/, ""), low: k.startsWith("-") }));
  const pool = inp.big.filter((sym) => {
    const f = inp.feats[sym];
    if (!f || inp.spots[sym] === undefined) return false;
    if (P.symbols) return P.symbols.includes(sym);
    if (noLev && leveraged.has(sym)) return false;
    if (u === "stocks" && funds.has(sym)) return false;
    if (u === "funds" && !funds.has(sym)) return false;
    if (u === "report" && f.score === null) return false;
    if (keys.some(({ k }) => f[k] === null || f[k] === undefined)) return false;
    return !P.filters || Object.entries(P.filters).every(([k, [lo, hi]]) => typeof f[k] === "number" && (lo === null || f[k]! >= lo) && (hi === null || f[k]! <= hi));
  });
  const val = (sym: string, k: string) => inp.feats[sym][k]!;
  if (keys.length === 1) {
    const { k, low } = keys[0];
    return pool.sort((a, b) => (low ? val(a, k) - val(b, k) : val(b, k) - val(a, k)) || (a < b ? -1 : 1));
  }
  const avg = new Map<string, number>();
  for (const { k, low } of keys) [...pool].sort((a, b) => (low ? val(a, k) - val(b, k) : val(b, k) - val(a, k)) || (a < b ? -1 : 1)).forEach((s, i) => avg.set(s, (avg.get(s) ?? 0) + i / keys.length));
  return pool.sort((a, b) => avg.get(a)! - avg.get(b)! || (a < b ? -1 : 1));
}

/** The chain windows the books need on Monday, [min, max] days out. */
export function leapWindow(B: LeapLevers): [number, number] {
  const ws = [B.calls?.dte, B.puts?.dte, B.shortPuts?.dte, B.coveredCalls?.dte, B.shortCalls?.dte].filter((w): w is [number, number] => !!w);
  return [Math.min(...ws.map((w) => w[0])), Math.max(...ws.map((w) => w[1]))];
}

/** The names the backtest should load Monday chains for: held, plus the top of each book's ranking (3× its slots). */
export function leapsWanted(rs: Ruleset, s: RaceState, inp: { feats: LeapsMondayInput["feats"]; big: string[]; funds: string[]; spots: Record<string, number> }, leveraged: Set<string>): string[] {
  const B = leapsOf(rs);
  if (!B) return [];
  const out = new Set(((s as LeapState).leaps ?? []).map((p) => p.symbol));
  for (const P of [B.calls, B.puts, B.shortPuts]) if (P) for (const sym of rankFor(P, inp, leveraged, B.noLeveraged ?? true).slice(0, Math.max(3 * P.maxNames, (P as LeapLong).keep ?? 0))) out.add(sym);
  return [...out];
}

/** The contract for a book: the expiry in the window nearest the target, then the strike nearest the |delta|. */
function pickContract(chain: LeapQuote[], right: "call" | "put", date: string, dte: [number, number], target: number | undefined, delta: number, maxSpread: number, minStrike = 0): LeapQuote | null {
  const ok = chain.filter((q) => {
    if (q.right !== right || q.delta === null || !q.bid || !q.ask || q.strike < minStrike) return false;
    const d = days(date, q.expiry);
    if (d < dte[0] || d > dte[1]) return false;
    const m = midOf(q);
    return m !== null && m > 0 && spreadOf(q) <= maxSpread * m;
  });
  if (!ok.length) return null;
  const t = target ?? (dte[0] + dte[1]) / 2;
  const exps = [...new Set(ok.map((q) => q.expiry))].sort((a, b) => Math.abs(days(date, a) - t) - Math.abs(days(date, b) - t));
  for (const e of exps) {
    const at = ok.filter((q) => q.expiry === e);
    const best = at.reduce((a, b) => (Math.abs(Math.abs(b.delta!) - delta) < Math.abs(Math.abs(a.delta!) - delta) ? b : a));
    if (Math.abs(Math.abs(best.delta!) - delta) <= 0.1) return best;
  }
  return null;
}

/** The quote for a held contract (put-call parity from the other side at the strike when it's missing). */
function quoteFor(chain: LeapQuote[] | undefined, p: LeapPos, spot: number | undefined): LeapQuote | null {
  if (!chain || !p.right) return null;
  const same = chain.filter((q) => q.expiry === p.expiry && Math.abs(q.strike - p.strike) <= 0.005 * p.strike);
  const q = same.find((x) => x.right === p.right && x.bid !== null && x.ask !== null && x.ask > 0);
  if (q) return q;
  const o = same.find((x) => x.right !== p.right && x.bid !== null && x.ask !== null && x.ask > 0);
  if (!o || spot === undefined) return null;
  // ignoring rates and dividends: C − P = S − K
  const k = p.right === "call" ? spot - p.strike : p.strike - spot;
  const bid = Math.max(0, o.bid! + k);
  const ask = Math.max(bid, o.ask! + k);
  return { ...o, right: p.right, bid, ask, delta: o.delta === null ? null : o.delta + (p.right === "call" ? 1 : -1) };
}

/** A mark for a held contract: the mid, else intrinsic plus the last mark's time value shrunk with the days left. */
function markOf(p: LeapPos, q: LeapQuote | null, spot: number | undefined, date: string) {
  if (p.book === "shares") return spot ?? p.mark;
  const m = q ? midOf(q) : null;
  if (m !== null && m !== undefined) return m;
  if (spot === undefined) return p.mark;
  const intrinsic = Math.max(0, p.right === "call" ? spot - p.strike : p.strike - spot);
  const left = Math.max(0, days(date, p.expiry));
  const was = Math.max(1, days(p.opened, p.expiry));
  return intrinsic + Math.max(0, p.mark - intrinsic) * Math.min(1, left / was);
}

const buyPx = (rs: Ruleset, q: OptionQuote) => r2(midOf(q)! + rs.ai.fillSpreadShare * spreadOf(q));
const sellPx = (rs: Ruleset, q: OptionQuote) => r2(Math.max(q.bid ?? 0, midOf(q)! - rs.ai.fillSpreadShare * spreadOf(q)));

const label: Record<LeapPos["book"], string> = { call: "LEAPS call", put: "LEAPS put", shortPut: "Long-dated put sold", coveredCall: "Long-dated covered call", shortCall: "Call sold against a LEAPS call", shares: "Shares (assigned)" };

function close(fees: number, s: LeapState, L: Ledger, p: LeapPos, px: number, q: OptionQuote | null, why: string) {
  const short = SHORT.has(p.book);
  const cash = p.book === "shares" ? px * p.qty : (short ? -1 : 1) * px * 100 * p.qty - fees * p.qty;
  s.cash += cash;
  s.leaps = s.leaps!.filter((x) => x.id !== p.id);
  const pnl = p.book === "shares" ? (px - p.cost) * p.qty : (short ? p.cost - px : px - p.cost) * 100 * p.qty - 2 * fees * p.qty;
  const action = p.book === "shares" ? "Sold shares" : short ? "Bought back" : "Sold option";
  L.add(action as Action, {
    symbol: p.symbol,
    type: p.book === "shares" ? "shares" : p.right!,
    strike: p.book === "shares" ? null : p.strike,
    expiration: p.book === "shares" ? null : p.expiry,
    qty: p.qty,
    price: px,
    bid: q?.bid ?? null,
    ask: q?.ask ?? null,
    cash,
    position_id: p.id,
    note: `${label[p.book]}: ${why}. ${usd(pnl)} vs the ${p.cost} ${short ? "sale" : "cost"}`,
  });
}

function open(rs: Ruleset, fees: number, s: LeapState, L: Ledger, date: string, sym: string, book: LeapPos["book"], q: LeapQuote, qty: number, why: string, link?: string) {
  const short = SHORT.has(book);
  const px = short ? sellPx(rs, q) : buyPx(rs, q);
  const cash = (short ? 1 : -1) * px * 100 * qty - fees * qty;
  s.cash += cash;
  const id = L.id("x");
  s.leaps!.push({ id, symbol: sym, book, right: q.right, strike: q.strike, expiry: q.expiry, qty, cost: px, mark: midOf(q)!, opened: date, link });
  L.add((short ? "Sold option" : "Bought option") as Action, {
    symbol: sym,
    type: q.right,
    strike: q.strike,
    expiration: q.expiry,
    qty,
    price: px,
    bid: q.bid,
    ask: q.ask,
    cash,
    position_id: id,
    note: `${label[book]}: ${why}; ${days(date, q.expiry)} days, delta ${q.delta?.toFixed(2) ?? "?"}`,
  });
  return id;
}

/** Monday at the close: marks, exits (rolls, take profit, stop, review), then new positions, then calls sold. */
export function leapsMonday(rs: Ruleset, fees: number, s0: RaceState, L: Ledger, date: string, inp: LeapsMondayInput | undefined, leveraged: Set<string>) {
  const B = leapsOf(rs);
  if (!B || !inp) return;
  const s = s0 as LeapState;
  s.leaps ??= [];
  for (const p of s.leaps) p.mark = markOf(p, quoteFor(inp.chains[p.symbol], p, inp.spots[p.symbol]), inp.spots[p.symbol], date);
  const cash0 = s.cash;
  const value = () => inp.baseValue + (s.cash - cash0) + leapsValue(s);
  const noLev = B.noLeveraged ?? true;

  // exits
  for (const p of [...s.leaps]) {
    if (p.book === "shares") continue;
    const q = quoteFor(inp.chains[p.symbol], p, inp.spots[p.symbol]);
    if (!q || midOf(q) === null || !q.ask) continue;
    const left = days(date, p.expiry);
    if (p.book === "call" || p.book === "put") {
      const S = p.book === "call" ? B.calls : B.puts;
      const px = sellPx(rs, q);
      const r = px / p.cost - 1;
      if (!S) continue;
      if (left <= S.rollAt) close(fees, s, L, p, px, q, `${left} days left, rolled`);
      else if (S.takeProfit !== undefined && r >= S.takeProfit) close(fees, s, L, p, px, q, `take profit (${(r * 100).toFixed(0)}% up)`);
      else if (S.stopLoss !== undefined && r <= -S.stopLoss) close(fees, s, L, p, px, q, `stop (${(-r * 100).toFixed(0)}% down)`);
    } else {
      const S = p.book === "shortPut" ? B.shortPuts : p.book === "coveredCall" ? B.coveredCalls : B.shortCalls;
      const px = buyPx(rs, q);
      const kept = 1 - px / p.cost;
      if (S?.takeProfit !== undefined && kept >= S.takeProfit) close(fees, s, L, p, px, q, `take profit (${(kept * 100).toFixed(0)}% of the premium kept)`);
      else if (p.book === "shortPut" && B.shortPuts?.rollAt !== undefined && left <= B.shortPuts.rollAt) close(fees, s, L, p, px, q, `${left} days left, rolled`);
    }
  }
  // assigned shares past the stop (their covered call is bought back first)
  const stop = B.shortPuts?.stop;
  if (stop !== undefined)
    for (const sh of s.leaps.filter((x) => x.book === "shares")) {
      const px = inp.spots[sh.symbol];
      if (px === undefined || px > (1 - stop) * sh.cost) continue;
      const cc = s.leaps.find((x) => x.book === "coveredCall" && x.link === sh.id);
      if (cc) {
        const q = quoteFor(inp.chains[cc.symbol], cc, px);
        close(fees, s, L, cc, q && midOf(q) !== null ? buyPx(rs, q) : Math.max(0, px - cc.strike), q, "the shares hit the stop");
      }
      close(fees, s, L, sh, r2(px), null, `stop (${((1 - px / sh.cost) * 100).toFixed(0)}% under the cost)`);
    }
  // a short call whose long call is gone goes with it
  for (const p of [...s.leaps]) if (p.book === "shortCall" && !s.leaps.some((x) => x.id === p.link)) {
    const q = quoteFor(inp.chains[p.symbol], p, inp.spots[p.symbol]);
    close(fees, s, L, p, q && midOf(q) !== null ? buyPx(rs, q) : Math.max(0, (inp.spots[p.symbol] ?? 0) - p.strike), q, "its LEAPS call was sold");
  }

  // long books: review, then fill the open slots
  for (const book of ["call", "put"] as const) {
    const S = book === "call" ? B.calls : B.puts;
    if (!S) continue;
    const ranked = rankFor(S, inp, leveraged, noLev);
    const pos = new Map(ranked.map((sym, i) => [sym, i]));
    const reviewing = inp.reviews[S.review ?? "quarterly"];
    if (reviewing) {
      const keep = S.keep ?? S.maxNames * 3;
      for (const p of s.leaps.filter((x) => x.book === book)) {
        const i = pos.get(p.symbol);
        const better = ranked.slice(0, S.maxNames).some((sym) => !s.leaps!.some((x) => x.book === book && x.symbol === sym));
        if ((i === undefined || i >= keep) && better) {
          const q = quoteFor(inp.chains[p.symbol], p, inp.spots[p.symbol]);
          if (q && midOf(q) !== null) close(fees, s, L, p, sellPx(rs, q), q, `review: ${i === undefined ? "out of the ranking" : `ranked #${i + 1}`}, sold for a better name`);
        }
      }
    }
    if ((S.regime === "on" && !inp.riskOn) || (S.regime === "off" && inp.riskOn)) continue;
    const each = (S.alloc * value()) / S.maxNames;
    for (const sym of ranked) {
      if (s.leaps.filter((x) => x.book === book).length >= S.maxNames) break;
      if (s.leaps.some((x) => x.book === book && x.symbol === sym)) continue;
      const spot = inp.spots[sym];
      const q = pickContract(inp.chains[sym] ?? [], book, date, S.dte, S.target, S.delta, S.maxSpread ?? 0.1);
      if (!q) continue;
      const px = buyPx(rs, q);
      // nearest whole contract (rounding down would leave a $100k book well under its target on pricier names)
      const qty = Math.round((S.sizing ?? "delta") === "delta" ? each / (Math.abs(q.delta!) * spot * 100) : each / (px * 100 + fees));
      // long options are paid in cash: never past what's left (the wheel's margin isn't for them)
      const afford = Math.floor(Math.max(0, s.cash) / (px * 100 + fees));
      const n = Math.min(qty, B.mode === "only" ? afford : qty);
      if (n < 1) continue;
      open(rs, fees, s, L, date, sym, book, q, n, `#${ranked.indexOf(sym) + 1} by ${Array.isArray(S.rank) ? S.rank.join(" + ") : (S.rank ?? "rand")}, price ${r2(spot)}`);
    }
  }

  // the long-dated wheel: puts sold on the open slots
  const SP = B.shortPuts;
  if (SP && !((SP.regime === "on" && !inp.riskOn) || (SP.regime === "off" && inp.riskOn))) {
    const ranked = rankFor(SP, inp, leveraged, noLev);
    const busy = (sym: string) => s.leaps!.some((x) => x.symbol === sym && (x.book === "shortPut" || x.book === "shares"));
    const v = value();
    const each = (SP.alloc * v) / SP.maxNames;
    for (const sym of ranked) {
      if (new Set(s.leaps.filter((x) => x.book === "shortPut" || x.book === "shares").map((x) => x.symbol)).size >= SP.maxNames) break;
      if (busy(sym)) continue;
      const q = pickContract(inp.chains[sym] ?? [], "put", date, SP.dte, SP.target, SP.delta, SP.maxSpread ?? 0.1);
      if (!q) continue;
      const room = (SP.maxExposure ?? 1) * v - wheelExposure(s);
      const n = Math.floor(Math.min(each, room) / (q.strike * 100));
      if (n < 1) continue;
      open(rs, fees, s, L, date, sym, "shortPut", q, n, `#${ranked.indexOf(sym) + 1} by ${Array.isArray(SP.rank) ? SP.rank.join(" + ") : (SP.rank ?? "rand")}, price ${r2(inp.spots[sym])}`);
    }
  }

  // calls sold: on assigned shares (covered calls) and against long calls (poor man's covered call)
  const CC = B.coveredCalls;
  if (CC)
    for (const sh of s.leaps.filter((x) => x.book === "shares")) {
      if (s.leaps.some((x) => x.book === "coveredCall" && x.link === sh.id)) continue;
      const n = Math.floor(sh.qty / 100);
      const q = n >= 1 ? pickContract(inp.chains[sh.symbol] ?? [], "call", date, CC.dte, CC.target, CC.delta, CC.maxSpread ?? 0.15, CC.aboveCost === false ? 0 : sh.cost) : null;
      if (q) open(rs, fees, s, L, date, sh.symbol, "coveredCall", q, n, `on ${sh.qty} shares bought at ${sh.cost}`, sh.id);
    }
  const SC = B.shortCalls;
  if (SC)
    for (const lc of s.leaps.filter((x) => x.book === "call")) {
      if (s.leaps.some((x) => x.book === "shortCall" && x.link === lc.id)) continue;
      const q = pickContract(inp.chains[lc.symbol] ?? [], "call", date, SC.dte, SC.target, SC.delta, SC.maxSpread ?? 0.15, Math.max(lc.strike, inp.spots[lc.symbol] ?? 0));
      if (q && q.expiry < lc.expiry) open(rs, fees, s, L, date, lc.symbol, "shortCall", q, lc.qty, `against the ${lc.strike} LEAPS call`, lc.id);
    }
}

/** Friday at the close: what expires settles, then everything open is marked. */
export function leapsFriday(rs: Ruleset, fees: number, s0: RaceState, L: Ledger, date: string, inp: LeapsFridayInput | undefined) {
  const s = s0 as LeapState;
  if (!leapsOf(rs) || !s.leaps?.length || !inp) return;
  for (const p of [...s.leaps]) {
    if (p.book === "shares" || p.expiry > date) continue;
    const c = inp.closes[p.symbol];
    const itm = c === undefined ? 0 : Math.max(0, p.right === "call" ? c - p.strike : p.strike - c);
    if (p.book === "shortPut" && itm > 0) {
      // assigned: the shares are bought at the strike
      s.leaps = s.leaps.filter((x) => x.id !== p.id);
      const cash = -p.strike * 100 * p.qty - fees * p.qty;
      s.cash += cash;
      const id = L.id("x");
      s.leaps.push({ id, symbol: p.symbol, book: "shares", right: null, strike: p.strike, expiry: "9999-12-31", qty: 100 * p.qty, cost: p.strike, mark: c!, opened: date });
      L.add("Assigned" as Action, { symbol: p.symbol, type: "put", strike: p.strike, expiration: p.expiry, qty: p.qty, price: p.strike, cash, position_id: p.id, note: `Long-dated put assigned (close ${r2(c!)}): bought ${100 * p.qty} shares at ${p.strike}; ${usd((p.cost - itm) * 100 * p.qty)} net of the premium` });
    } else if (p.book === "coveredCall" && itm > 0) {
      // called away: the shares go at the strike
      const sh = s.leaps.find((x) => x.id === p.link);
      s.leaps = s.leaps.filter((x) => x.id !== p.id && x.id !== p.link);
      const shares = Math.min(sh?.qty ?? 0, 100 * p.qty);
      const cash = p.strike * shares - fees * p.qty;
      s.cash += cash;
      if (sh && sh.qty > shares) s.leaps.push({ ...sh, qty: sh.qty - shares });
      L.add("Called away", { symbol: p.symbol, type: "call", strike: p.strike, expiration: p.expiry, qty: p.qty, price: p.strike, cash, position_id: p.id, note: `Long-dated covered call (close ${r2(c!)}): ${shares} shares sold at ${p.strike}, ${usd((p.strike - (sh?.cost ?? p.strike)) * shares)} vs their cost` });
    } else if (itm > 0) {
      // long options are paid their intrinsic value; a call sold against a LEAPS call is closed at it
      close(fees, s, L, p, r2(itm), null, `expired in the money (close ${r2(c!)})`);
    } else {
      s.leaps = s.leaps.filter((x) => x.id !== p.id);
      const pnl = (SHORT.has(p.book) ? p.cost : -p.cost) * 100 * p.qty - fees * p.qty;
      L.add("Expired", { symbol: p.symbol, type: p.right!, strike: p.strike, expiration: p.expiry, qty: p.qty, price: 0, cash: 0, position_id: p.id, note: `${label[p.book]}: expired worthless${c === undefined ? " (no close)" : ` (close ${r2(c)})`}. ${usd(pnl)}` });
    }
  }
  for (const p of s.leaps) p.mark = markOf(p, quoteFor(inp.chains[p.symbol], p, inp.closes[p.symbol]), inp.closes[p.symbol], date);
}

/** The held contracts' symbols and expiries, for Friday's chain load. */
export function leapsHeld(s: RaceState): { symbol: string; expiries: string[] }[] {
  const by = new Map<string, Set<string>>();
  for (const p of (s as LeapState).leaps ?? []) {
    if (p.book === "shares") {
      by.set(p.symbol, by.get(p.symbol) ?? new Set());
      continue;
    }
    by.set(p.symbol, (by.get(p.symbol) ?? new Set()).add(p.expiry));
  }
  return [...by].map(([symbol, e]) => ({ symbol, expiries: [...e] }));
}
