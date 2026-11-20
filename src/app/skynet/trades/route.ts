import { NextResponse, type NextRequest } from "next/server";
import { loadRun } from "@/lib/skynet-runs";

/** One week's trades from a local backtest run, for the /skynet page's week rows (loaded when a week is opened). */
export function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("run") ?? "";
  const week = Number(request.nextUrl.searchParams.get("week"));
  const { run, error } = loadRun(id);
  if (!run) return NextResponse.json({ error }, { status: 404 });
  return NextResponse.json({ trades: run.trades.filter((t) => t.week === week) });
}
