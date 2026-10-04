/**
 * Fill a DEMO database with made-up wheel history (same tickers, fake numbers).
 *
 *   ENV_FILE=.env.demo npm run demo:seed -- --wipe <demo-project-ref>
 *
 * Safety: refuses to run against the project in .env.local, and only wipes when the
 * project ref you pass matches NEXT_PUBLIC_SUPABASE_URL. Deterministic (seeded RNG),
 * so re-running rebuilds the same demo.
 *
 * Model: each ticker's price follows a seeded weekly random walk. Every week puts are
 * sold ~5% below price with round premiums; outcomes follow from where price lands on
 * Friday (expire / assigned), plus occasional early buybacks and rolls. Assigned shares
 * get covered calls until called away or, sometimes, sold at a loss. Tesla CC sells weekly
 * calls against 1,000 pre-owned TSLA shares and rolls up-and-out when threatened.
 */
import "./env";
import { readFileSync, existsSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase";
import { assignTrade, closeTrade, expireTrade, openTrade, rollTrade } from "../src/lib/trades";

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const wipeIdx = process.argv.indexOf("--wipe");
const ref = wipeIdx > 0 ? process.argv[wipeIdx + 1] : "";

function realProjectUrl() {
  if (!existsSync(".env.local")) return null;
  const m = readFileSync(".env.local", "utf8").match(/^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m);
  return m?.[1].trim() ?? null;
}

if (!process.env.ENV_FILE) throw new Error("Run with ENV_FILE=.env.demo so this can never touch your real database.");
if (url && url === realProjectUrl()) throw new Error("Refusing: ENV_FILE points at the same project as .env.local.");
if (!ref || !url.includes(ref)) throw new Error(`Pass --wipe <project-ref> matching ${url || "NEXT_PUBLIC_SUPABASE_URL"}.`);

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

let seed = 20260101;
function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => rand() < p;
const round = (n: number, step: number) => Math.round(n / step) * step;
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// universe
// ---------------------------------------------------------------------------

interface Ticker {
  symbol: string;
  price: number;
  vol: number; // weekly move, fraction
  strikeStep: number;
  account: "Individual" | "Joint";
  contracts: number;
}

const UNIVERSE: Ticker[] = [
  { symbol: "ASTS", price: 60, vol: 0.09, strikeStep: 1, account: "Individual", contracts: 4 },
  { symbol: "RKLB", price: 70, vol: 0.08, strikeStep: 1, account: "Individual", contracts: 3 },
  { symbol: "OUST", price: 30, vol: 0.08, strikeStep: 0.5, account: "Individual", contracts: 8 },
  { symbol: "NBIS", price: 150, vol: 0.07, strikeStep: 2.5, account: "Individual", contracts: 2 },
  { symbol: "IREN", price: 40, vol: 0.08, strikeStep: 0.5, account: "Individual", contracts: 5 },
  { symbol: "HOOD", price: 100, vol: 0.06, strikeStep: 1, account: "Individual", contracts: 3 },
  { symbol: "SOFI", price: 20, vol: 0.06, strikeStep: 0.5, account: "Individual", contracts: 10 },
  { symbol: "ONDS", price: 8, vol: 0.1, strikeStep: 0.5, account: "Individual", contracts: 20 },
  { symbol: "PLTR", price: 150, vol: 0.06, strikeStep: 2.5, account: "Joint", contracts: 2 },
  { symbol: "GOOG", price: 300, vol: 0.04, strikeStep: 2.5, account: "Joint", contracts: 1 },
  { symbol: "AAOI", price: 90, vol: 0.08, strikeStep: 1, account: "Joint", contracts: 2 },
];

const START = "2026-01-05"; // a Monday
const WEEKS = 38;

// ---------------------------------------------------------------------------

interface OpenPut {
  id: string;
  t: Ticker;
  strike: number;
  premium: number;
  qty: number;
}
interface Holding {
  t: Ticker;
  shares: number;
  weeksHeld: number;
  callId: string | null;
  callStrike: number;
  callQty: number;
}

async function wipe(db: SupabaseClient) {
  for (const table of ["transactions", "positions", "snapshots"]) {
    const { error } = await db.from(table).delete().not("id", "is", null);
    if (error) throw new Error(`wipe ${table}: ${error.message}`);
  }
}

async function main() {
  const db = createAdminClient();
  const { data: accounts, error } = await db.from("accounts").select("id, name");
  if (error) throw new Error(error.message);
  const acct = new Map((accounts ?? []).map((a) => [a.name as string, a.id as string]));
  const { data: streams } = await db.from("streams").select("id, slug");
  const streamId = new Map((streams ?? []).map((s) => [s.slug as string, s.id as string]));
  if (!acct.get("Individual") || !acct.get("Joint")) throw new Error("Run the migrations first (accounts are seeded there).");

  console.log(`Wiping ${url} ...`);
  await wipe(db);

  const price = new Map(UNIVERSE.map((t) => [t.symbol, t.price]));
  let tsla = 400;
  let tslaCall: { id: string; strike: number } | null = null;
  const holdings = new Map<string, Holding>(); // symbol → shares from assignment
  let cash = { Individual: 100_000, Joint: 250_000 };
  const premiumToDate = { Individual: 0, Joint: 0 };
  let n = 0;

  // one extra iteration: the final Monday's trades are opened and left open ("this week")
  for (let w = 0; w <= WEEKS; w++) {
    const monday = addDays(START, w * 7);
    const friday = addDays(monday, 4);
    const puts: OpenPut[] = [];

    // --- Monday: sell puts on tickers not currently held, covered calls on holdings
    for (const t of UNIVERSE) {
      const p = price.get(t.symbol)!;
      const held = holdings.get(t.symbol);
      if (held) {
        const cost = held.shares ? held.callStrike : p;
        const strike = round(Math.max(cost, p * 1.04), t.strikeStep);
        const premium = Math.max(0.1, round(p * 0.012, 0.05));
        const qty = held.shares / 100;
        held.callId = await openTrade(db, {
          accountId: acct.get(t.account)!,
          ticker: t.symbol,
          kind: "CC",
          strike,
          expiration: friday,
          quantity: qty,
          price: premium,
          date: monday,
        });
        held.callStrike = strike;
        held.callQty = qty;
        premiumToDate[t.account] += premium * qty * 100;
        n++;
        continue;
      }
      if (!chance(0.8)) continue; // skip a few tickers each week
      const strike = round(p * 0.95, t.strikeStep);
      const premium = Math.max(0.1, round(p * 0.014 + rand() * p * 0.004, 0.05));
      const id = await openTrade(db, {
        accountId: acct.get(t.account)!,
        ticker: t.symbol,
        kind: "CSP",
        strike,
        expiration: friday,
        quantity: t.contracts,
        price: premium,
        date: monday,
      });
      puts.push({ id, t, strike, premium, qty: t.contracts });
      premiumToDate[t.account] += premium * t.contracts * 100;
      n++;
    }

    // --- Tesla CC: weekly calls ~8% out of the money on 1,000 pre-owned shares
    if (!tslaCall) {
      const strike = round(tsla * 1.08, 5);
      tslaCall = {
        strike,
        id: await openTrade(db, {
          accountId: acct.get("Joint")!,
          streamId: streamId.get("tesla"),
          ticker: "TSLA",
          kind: "CC",
          strike,
          expiration: friday,
          quantity: 10,
          price: round(tsla * 0.004, 0.05),
          date: monday,
        }),
      };
      premiumToDate.Joint += round(tsla * 0.004, 0.05) * 1000;
      n++;
    }

    if (w === WEEKS) break;

    // --- the week happens
    for (const t of UNIVERSE) {
      const p = price.get(t.symbol)!;
      const drift = 0.004;
      price.set(t.symbol, Math.max(2, p * (1 + drift + (rand() * 2 - 1) * t.vol)));
    }
    tsla = tsla * (1 + 0.004 + (rand() * 2 - 1) * 0.05);
    const wed = addDays(monday, 2);
    const thu = addDays(monday, 3);

    // --- midweek: take quick profits on some puts, roll some that are in trouble
    for (const put of [...puts]) {
      const p = price.get(put.t.symbol)!;
      if (p > put.strike * 1.08 && chance(0.25)) {
        await closeTrade(db, { positionId: put.id, price: round(put.premium * 0.2, 0.05) || 0.05, date: wed });
        puts.splice(puts.indexOf(put), 1);
        n++;
      } else if (p < put.strike * 0.93 && chance(0.3)) {
        // cut a loser: buy back at a loss rather than risk assignment
        await closeTrade(db, { positionId: put.id, price: round(put.strike - p + put.premium * 0.3, 0.05), date: wed });
        puts.splice(puts.indexOf(put), 1);
        n++;
      } else if (p < put.strike && chance(0.35)) {
        const newStrike = round(put.strike - put.t.strikeStep * 2, put.t.strikeStep);
        const closePrice = round(put.strike - p + put.premium * 0.5, 0.05);
        await rollTrade(db, {
          positionId: put.id,
          closePrice,
          newStrike,
          newExpiration: addDays(friday, 7),
          newPrice: round(closePrice + 0.2, 0.05),
          date: thu,
        });
        puts.splice(puts.indexOf(put), 1);
        n += 2;
      }
    }

    // --- Tesla: roll up and out for a credit when the call goes in the money
    if (tslaCall && tsla > tslaCall.strike * 0.99) {
      const newStrike = round(tsla * 1.07, 5);
      const closePrice = round(Math.max(tsla - tslaCall.strike, 0) + 1.5, 0.05);
      const id = await rollTrade(db, {
        positionId: tslaCall.id,
        closePrice,
        newStrike,
        newExpiration: addDays(friday, 7),
        newPrice: round(closePrice + 1, 0.05),
        date: thu,
      });
      tslaCall = { id, strike: newStrike };
      premiumToDate.Joint += 100;
      n += 2;
    }

    // --- Friday: settle this week's puts (including rolled legs expiring now)
    const { data: expiring } = await db
      .from("v_positions")
      .select("id, ticker, option_type, strike, account_id")
      .eq("status", "open")
      .eq("instrument", "option")
      .eq("expiration", friday);
    for (const pos of expiring ?? []) {
      const strike = Number(pos.strike);
      if (pos.ticker === "TSLA") {
        await expireTrade(db, { positionId: pos.id, date: friday });
        tslaCall = null;
        continue;
      }
      const t = UNIVERSE.find((u) => u.symbol === pos.ticker)!;
      const p = price.get(pos.ticker)!;
      if (pos.option_type === "put") {
        if (p < strike) {
          await assignTrade(db, { positionId: pos.id, date: friday, underlyingClose: p });
          const { data: pq } = await db.from("v_positions").select("quantity").eq("id", pos.id).single();
          const shares = Number(pq?.quantity ?? t.contracts) * 100;
          const h = holdings.get(t.symbol);
          if (h) h.shares += shares;
          else holdings.set(t.symbol, { t, shares, weeksHeld: 0, callId: null, callStrike: strike, callQty: 0 });
        } else await expireTrade(db, { positionId: pos.id, date: friday });
      } else {
        const h = holdings.get(t.symbol);
        if (p > strike) {
          await assignTrade(db, { positionId: pos.id, date: friday, underlyingClose: p }); // called away
          holdings.delete(t.symbol);
        } else {
          await expireTrade(db, { positionId: pos.id, date: friday });
          if (h) h.callId = null;
        }
      }
      n++;
    }

    // --- sometimes give up on shares that keep falling
    for (const [symbol, h] of holdings) {
      h.weeksHeld++;
      const p = price.get(symbol)!;
      if (h.weeksHeld >= 6 && p < h.callStrike * 0.85 && chance(0.4)) {
        const { data: lots } = await db
          .from("v_positions")
          .select("id")
          .eq("ticker", symbol)
          .eq("instrument", "stock")
          .eq("status", "open");
        for (const lot of lots ?? []) {
          await closeTrade(db, { positionId: lot.id, price: round(p, 0.01), date: addDays(friday, 3) });
        }
        holdings.delete(symbol);
        n++;
      }
    }

    // --- weekly snapshots
    cash = {
      Individual: Math.round(100_000 + premiumToDate.Individual * 0.8),
      Joint: Math.round(250_000 + premiumToDate.Joint * 0.8),
    };
    const snaps = [
      { account_id: acct.get("Individual")!, stream_id: null, total_value: cash.Individual },
      { account_id: acct.get("Joint")!, stream_id: null, total_value: cash.Joint + Math.round(tsla * 1000) - 200_000 },
      { account_id: acct.get("Joint")!, stream_id: streamId.get("tesla")!, total_value: Math.round(tsla * 1000) },
      { account_id: acct.get("Joint")!, stream_id: streamId.get("joint")!, total_value: 50_000 + Math.round(premiumToDate.Joint * 0.3) },
    ];
    for (const s of snaps) {
      const { error: e } = await db
        .from("snapshots")
        .upsert({ ...s, as_of: friday, source: "import" }, { onConflict: "account_id,stream_id,as_of" });
      if (e) throw new Error(`snapshot: ${e.message}`);
    }

    process.stdout.write(`\rweek ${w + 1}/${WEEKS} (${friday}) · ${n} events`);
  }
  console.log(`\nDemo data ready (last week left open, expiring ${addDays(START, WEEKS * 7 + 4)}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
