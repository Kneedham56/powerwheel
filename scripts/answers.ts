/**
 * Reading saved Robinhood tool answers (shared by scripts/prep.ts and scripts/race.ts).
 * Answers are saved to files exactly as returned, so raw data never has to pass through a conversation.
 */
import { readFileSync } from "node:fs";
import type { Bar, OptionQuote } from "../src/lib/rules";

/** A saved tool answer: plain JSON, a content-block array, or JSON after a header line. */
export function readAnswer(path: string): unknown {
  const text = readFileSync(path, "utf8");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    if (i < 0) throw new Error(`${path}: not JSON`);
    v = JSON.parse(text.slice(i));
  }
  if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "text" in v[0]) {
    return JSON.parse((v as { text: string }[]).map((b) => b.text).join(""));
  }
  return v;
}

export const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function parseBars(files: string[], value = false): Record<string, Bar[]> {
  const out: Record<string, Map<string, Bar>> = {};
  for (const f of files) {
    const a = readAnswer(f) as Any;
    const results: Any[] = a?.data?.results ?? a?.results ?? [];
    if (!results.length) throw new Error(`${f}: no price history in it`);
    for (const r of results) {
      const sym = r.symbol || (value ? "VIX" : "");
      if (!sym) continue;
      const m = (out[sym] ??= new Map());
      for (const b of r.bars ?? []) {
        if (b.interpolated) continue;
        const pick = (k: string) => num(b[`${k}_price`] ?? b[`${k}_value`]);
        const close = pick("close");
        if (close === null) continue;
        const date = String(b.begins_at).slice(0, 10);
        m.set(date, { date, open: pick("open") ?? close, high: pick("high") ?? close, low: pick("low") ?? close, close });
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([s, m]) => [s, [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1))]));
}

/**
 * Option quotes, in either form:
 *  - raw get_option_instruments and get_option_quotes answers (any order, any number of files), joined by id;
 *  - a compact file {"SYM": [{strike, expiry, bid, ask, mark, delta, iv, open_interest}, ...]} (what a helper agent
 *    returns, so the raw chains never have to pass through the conversation).
 */
export function parseOptions(files: string[], type: "put" | "call" = "put"): Record<string, OptionQuote[]> {
  const inst = new Map<string, Any>();
  const quotes = new Map<string, Any>();
  const out: Record<string, OptionQuote[]> = {};
  for (const f of files) {
    const a = readAnswer(f) as Any;
    if (a && !a.data && typeof a === "object") {
      for (const [sym, rows] of Object.entries(a as Record<string, Any[]>)) {
        for (const q of rows ?? []) {
          (out[sym] ??= []).push({
            strike: Number(q.strike),
            expiry: q.expiry ?? q.expiration_date,
            bid: num(q.bid),
            ask: num(q.ask),
            mark: num(q.mark),
            delta: num(q.delta),
            iv: num(q.iv),
            openInterest: num(q.open_interest ?? q.openInterest),
          });
        }
      }
      continue;
    }
    for (const i of a?.data?.instruments ?? []) inst.set(i.id, i);
    for (const r of a?.data?.results ?? []) if (r.quote?.instrument_id) quotes.set(r.quote.instrument_id, r.quote);
  }
  for (const [id, i] of inst) {
    if (i.type && i.type !== type) continue;
    const q = quotes.get(id);
    if (!q) continue;
    (out[i.chain_symbol] ??= []).push({
      strike: Number(i.strike_price),
      expiry: i.expiration_date,
      bid: num(q.bid_price),
      ask: num(q.ask_price),
      mark: num(q.mark_price),
      delta: num(q.delta),
      iv: num(q.implied_volatility),
      openInterest: num(q.open_interest),
    });
  }
  return out;
}
