/**
 * Thin client for the local Theta Terminal v3 REST API (http://127.0.0.1:25503/v3).
 * The terminal must be running and logged in; see docs/SKYNET-DATA.md.
 */

export const THETA_URL = (process.env.THETA_URL ?? "http://127.0.0.1:25503/v3").replace(/\/$/, "");

export type Outcome =
  | { kind: "ok"; csv: string; ms: number }
  | { kind: "no_data"; ms: number }
  | { kind: "forbidden"; message: string; ms: number };

export class ThetaError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`Theta ${status} on ${path}: ${body.slice(0, 200)}`);
  }
}

// 429 OS throttling, 474 lost connection to Theta servers, 571 server starting, 5xx.
const RETRYABLE = new Set([429, 474, 500, 502, 503, 504, 571, 572]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a CSV endpoint. Retries transient errors (and a terminal that is down) with backoff.
 * 472 means no data for that request; 403 or 471 means the subscription doesn't cover it.
 */
export async function thetaGet(path: string, params: Record<string, string | number>, maxWaitMs = 15 * 60_000): Promise<Outcome> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const url = `${THETA_URL}/${path}?${qs}`;
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    const t0 = Date.now();
    let status = 0;
    let body = "";
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      status = res.status;
      body = await res.text();
    } catch (e) {
      body = e instanceof Error ? e.message : String(e); // terminal down or timeout
    }
    const ms = Date.now() - t0;
    if (status === 200) return { kind: "ok", csv: body, ms };
    if (status === 472) return { kind: "no_data", ms };
    if (status === 403 || status === 471 || (status === 400 && /subscription|upgrad/i.test(body))) {
      return { kind: "forbidden", message: body.trim(), ms };
    }
    if ((status === 0 || RETRYABLE.has(status)) && Date.now() - started < maxWaitMs) {
      attempt++;
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
      if (attempt === 1 || attempt % 5 === 0) console.warn(`  retry ${attempt} in ${wait / 1000}s (${status || "no response"}) ${path} ${qs}`);
      await sleep(wait);
      continue;
    }
    throw new ThetaError(status, body, `${path}?${qs}`);
  }
}

/** Minimal CSV line parser for Theta output (fields may be double-quoted; no embedded quotes). */
export function csvHeader(csv: string): string[] {
  const nl = csv.indexOf("\n");
  const first = (nl === -1 ? csv : csv.slice(0, nl)).replace(/\r$/, "");
  return first ? first.split(",").map((s) => s.replace(/^"|"$/g, "").trim()) : [];
}

export function csvRows(csv: string): string[][] {
  return csv
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean)
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")));
}
