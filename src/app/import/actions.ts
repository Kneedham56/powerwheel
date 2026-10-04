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
const NEW = "__new__";
const AUTO = "auto";
const PALETTE = ["#2a78d6", "#1f9e75", "#d8532b", "#8a5cd1", "#c9a227", "#d6457a", "#4a9fb5", "#7a8a2a"];

export interface ImportTarget {
  /** an account id, or "__new__" with newAccount set */
  account: string;
  newAccount?: string;
  /** "auto" (use the stream rules), a stream id, or "__new__" with newStream set */
  stream: string;
  newStream?: string;
}

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

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "stream";

/** Find or create the account and stream a file should land in. Repeating it (one call per step) is harmless. */
async function resolveTarget(t: ImportTarget): Promise<{ accountId: string; streamId: string | null }> {
  const client = db();
  let accountId = t.account;
  if (t.account === NEW) {
    const name = (t.newAccount ?? "").trim();
    if (!name) throw new Error("Name the new account.");
    const { data: found } = await client.from("accounts").select("id").ilike("name", name).maybeSingle();
    if (found) accountId = found.id;
    else {
      const { data, error } = await client.from("accounts").insert({ name }).select("id").single();
      if (error) throw new Error(error.message);
      accountId = data.id;
    }
  } else {
    const { data } = await client.from("accounts").select("id").eq("id", accountId).maybeSingle();
    if (!data) throw new Error("Pick an account first.");
  }

  let streamId: string | null = null;
  if (t.stream === NEW) {
    const name = (t.newStream ?? "").trim();
    if (!name) throw new Error("Name the new stream.");
    const { data: found } = await client.from("streams").select("id").ilike("name", name).maybeSingle();
    if (found) streamId = found.id;
    else {
      const { data: existing } = await client.from("streams").select("sort_order");
      const next = Math.max(0, ...(existing ?? []).map((r) => Number(r.sort_order))) + 1;
      const { data, error } = await client
        .from("streams")
        .insert({ name, slug: slug(name), color: PALETTE[(existing?.length ?? 0) % PALETTE.length], sort_order: next })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      streamId = data.id;
    }
  } else if (t.stream !== AUTO) {
    const { data } = await client.from("streams").select("id").eq("id", t.stream).maybeSingle();
    if (!data) throw new Error("Pick a stream.");
    streamId = data.id;
  } else {
    // automatic: only works when a stream rule already covers this account
    const { data } = await client.rpc("assign_stream", { p_account: accountId, p_ticker: "X", p_kind: "put" });
    if (!data) throw new Error("No stream rule covers this account yet. Choose a stream (or create a new one) for this file.");
  }
  return { accountId, streamId };
}

export async function importCsvStep(target: ImportTarget, text: string, cursor: number, dryRun: boolean): Promise<ImportStep> {
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

    const { accountId, streamId } = await resolveTarget(target);
    const r = await applyEvents(db(), accountId, plan.events, cursor, STEP_BUDGET_MS, streamId);
    if (r.next === null) revalidatePath("/", "layout");
    return { ...empty, ...summary, ok: true, next: r.next, applied: r.applied, skipped: r.skipped, warnings: r.warnings };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}
