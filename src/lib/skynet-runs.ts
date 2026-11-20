import "server-only";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunFile } from "../../skynet/results";

/**
 * Skynet backtest runs, read from data/backtests on this machine (gitignored, local only). A deployed copy of the app
 * has no data folder, so it finds no runs.
 */

export interface RunEntry {
  id: string; // "<ruleset>/<from>_<to>_<stamp>"
  ruleset: string;
  from: string;
  to: string;
  stamp: string;
  mtime: number;
}

// next.config.ts keeps data/ out of the build's file trace (it holds gigabytes of licensed market data)
const dir = () => join(process.cwd(), "data", "backtests");

export function listRuns(): RunEntry[] {
  const root = dir();
  if (!existsSync(root)) return [];
  const out: RunEntry[] = [];
  for (const rs of readdirSync(root)) {
    const rsDir = join(root, rs);
    if (!statSync(rsDir).isDirectory()) continue;
    for (const run of readdirSync(rsDir)) {
      const file = join(rsDir, run, "run.json");
      const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_(\d{8}-\d{6})$/.exec(run);
      // runs written before format 2 have no weeks or trades to show; run.json starts with {"format":N
      if (!m || !existsSync(file) || !viewable(file)) continue;
      out.push({ id: `${rs}/${run}`, ruleset: rs, from: m[1], to: m[2], stamp: m[3], mtime: statSync(file).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function viewable(file: string) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, 32, 0);
    const m = /^\{\s*"format"\s*:\s*(\d+)/.exec(buf.subarray(0, n).toString("utf8"));
    return !!m && Number(m[1]) >= 2;
  } finally {
    closeSync(fd);
  }
}

/** Parsed runs, kept while the file is unchanged (a run.json is several MB). */
const cache = new Map<string, { mtime: number; run: RunFile }>();

/** A run by id (only ids that listRuns returns, so the id can't reach outside data/backtests). */
export function loadRun(id: string, runs = listRuns()): { run: RunFile | null; error?: string } {
  const entry = runs.find((r) => r.id === id);
  if (!entry) return { run: null, error: "No such run." };
  let hit = cache.get(id);
  if (!hit || hit.mtime !== entry.mtime) {
    const run = JSON.parse(readFileSync(join(dir(), entry.ruleset, id.split("/")[1], "run.json"), "utf8")) as RunFile;
    hit = { mtime: entry.mtime, run };
    cache.set(id, hit);
  }
  const run = hit.run;
  if ((run.format ?? 1) < 2 || !run.weeks) return { run: null, error: "This run predates the page (no weeks in run.json). Run the backtest again to see it here." };
  return { run };
}
