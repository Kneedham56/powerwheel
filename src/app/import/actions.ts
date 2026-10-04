"use server";

// CSV import runs in steps so a long history fits inside a serverless time limit: each call
// applies events until its budget is used and says where to resume. Re-running is safe, rows
// already imported are skipped (see lib/csv-import.ts).

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, isDemo, isValidSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { applyEvents, planImport } from "@/lib/csv-import";

const STEP_BUDGET_MS = 40_000;

export interface ImportStep {
  ok: boolean;
  error?: string;
  total: number;
  /** event index to resume from, null when finished */
  next: number | null;
  applied: number;
  skipped: number;
  warnings: string[];
  stats: Record<string, number>;
  ignored: Record<string, number>;
  range: { from: string; to: string } | null;
  planWarnings: string[];
}

const empty: ImportStep = {
  ok: false,
  total: 0,
  next: null,
  applied: 0,
  skipped: 0,
  warnings: [],
  stats: {},
  ignored: {},
  range: null,
  planWarnings: [],
};

export async function importCsvStep(accountId: string, text: string, cursor: number, dryRun: boolean): Promise<ImportStep> {
  try {
    if (isDemo()) throw new Error("This is a read-only demo — changes are disabled.");
    if (!(await isValidSession((await cookies()).get(SESSION_COOKIE)?.value))) throw new Error("Please sign in again.");

    const plan = planImport(text);
    const summary = {
      total: plan.events.length,
      stats: plan.stats,
      ignored: plan.ignored,
      range: plan.range,
      planWarnings: plan.warnings,
    };
    if (dryRun) return { ...empty, ...summary, ok: true };

    const { data: account } = await db().from("accounts").select("id").eq("id", accountId).maybeSingle();
    if (!account) throw new Error("Pick an account first.");

    const r = await applyEvents(db(), accountId, plan.events, cursor, STEP_BUDGET_MS);
    if (r.next === null) revalidatePath("/", "layout");
    return { ...empty, ...summary, ok: true, next: r.next, applied: r.applied, skipped: r.skipped, warnings: r.warnings };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}
