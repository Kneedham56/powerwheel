const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function money(n: number | null | undefined, whole = false) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return (whole ? usd0 : usd).format(n);
}

export function pct(n: number | null | undefined, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function num(n: number | null | undefined, digits = 2) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** "2026-08-07" or timestamp → "Aug 7, 26" */
export function shortDate(d: string | null | undefined) {
  if (!d) return "—";
  const date = d.length === 10 ? new Date(`${d}T12:00:00Z`) : new Date(d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "America/New_York" });
}

export function signClass(n: number | null | undefined) {
  if (!n) return "";
  return n > 0 ? "text-gain" : "text-loss";
}

export function contractLabel(p: { ticker: string; strike: number | null; option_type: string | null; expiration: string | null; instrument: string }) {
  if (p.instrument === "stock") return `${p.ticker} shares`;
  return `${p.ticker} ${num(p.strike)}${p.option_type === "put" ? "P" : "C"} ${shortDate(p.expiration)}`;
}
