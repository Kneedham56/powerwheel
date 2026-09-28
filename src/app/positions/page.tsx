import Link from "next/link";
import {
  assignTradeAction,
  closeTradeAction,
  deletePositionAction,
  expireTradeAction,
  rollTradeAction,
  updatePositionAction,
} from "@/app/actions";
import { Chips, Flash, PageTitle, StatusPill, StreamDot, param } from "@/components/ui";
import { loadAll } from "@/lib/db";
import { contractLabel, money, num, pct, shortDate, signClass } from "@/lib/format";
import { todayEt } from "@/lib/reports";
import type { PositionRow, Stream } from "@/lib/types";

export default async function PositionsPage({ searchParams }: PageProps<"/positions">) {
  const sp = await searchParams;
  const { streams, positions } = await loadAll();

  const view = param(sp, "view") ?? "open";
  const streamId = param(sp, "stream");
  const ticker = param(sp, "ticker")?.toUpperCase();

  const rows = positions
    .filter((p) => (view === "open" ? p.status === "open" : p.status !== "open"))
    .filter((p) => !streamId || p.stream_id === streamId)
    .filter((p) => !ticker || p.ticker === ticker)
    .sort((a, b) =>
      view === "open"
        ? (a.expiration ?? "9999").localeCompare(b.expiration ?? "9999")
        : (b.closed_at ?? "").localeCompare(a.closed_at ?? ""),
    );

  const back = `/positions?${new URLSearchParams(
    Object.entries(sp).filter(([k, v]) => typeof v === "string" && k !== "ok" && k !== "error") as [string, string][],
  )}`;
  const today = todayEt();

  return (
    <div className="space-y-4">
      <Flash sp={sp} />
      <PageTitle
        right={
          <Link href="/trades/new" className="btn">
            + New trade
          </Link>
        }
      >
        Positions
      </PageTitle>

      <div className="card flex flex-wrap items-center gap-3">
        <Chips
          sp={sp}
          path="/positions"
          name="view"
          options={[
            { value: "", label: "Open" },
            { value: "closed", label: "History" },
          ]}
        />
        <Chips
          sp={sp}
          path="/positions"
          name="stream"
          options={[{ value: "", label: "All streams" }, ...streams.map((s) => ({ value: s.id, label: s.name }))]}
        />
        <form className="ml-auto flex gap-2" action="/positions">
          {view !== "open" && <input type="hidden" name="view" value={view} />}
          {streamId && <input type="hidden" name="stream" value={streamId} />}
          <input name="ticker" defaultValue={ticker} placeholder="Ticker" className="input w-28" />
          <button className="btn-ghost">Filter</button>
        </form>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Contract</th>
              <th>Type</th>
              <th>Stream</th>
              <th className="num">Qty</th>
              <th className="num">Open price</th>
              <th className="num">{view === "open" ? "Premium held" : "Net P&L"}</th>
              <th className="num">Return</th>
              <th>{view === "open" ? "DTE" : "Closed"}</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <PositionRowView key={p.id} p={p} streams={streams} back={back} today={today} view={view} />
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={10} className="text-muted">
                  {view === "open" ? "No open positions." : "No closed positions match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function dte(expiration: string | null, today: string) {
  if (!expiration) return "—";
  const days = Math.round((Date.parse(expiration) - Date.parse(today)) / 86_400_000);
  return days < 0 ? `${-days}d past` : `${days}d`;
}

function PositionRowView({
  p,
  streams,
  back,
  today,
  view,
}: {
  p: PositionRow;
  streams: Stream[];
  back: string;
  today: string;
  view: string;
}) {
  const expiredUnhandled = p.status === "open" && p.expiration && p.expiration < today;
  return (
    <>
      <tr className={expiredUnhandled ? "bg-amber-500/10" : undefined}>
        <td className="font-medium">
          {contractLabel(p)}
          {p.rolled_from_id && <span className="ml-1.5 text-xs text-muted">(rolled)</span>}
        </td>
        <td>{p.strategy}</td>
        <td>
          <StreamDot color={p.stream_color} />
          {p.stream_name} <span className="text-xs text-muted">· {p.account_name}</span>
        </td>
        <td className="num">{num(view === "open" ? p.open_quantity : p.quantity)}</td>
        <td className="num">{money(p.open_price)}</td>
        <td className={`num ${signClass(p.net_amount)}`}>
          {p.instrument === "stock" && p.status === "open" ? "—" : money(p.net_amount)}
        </td>
        <td className="num">{p.collateral ? pct(p.net_amount / p.collateral, 2) : "—"}</td>
        <td>{view === "open" ? dte(p.expiration, today) : shortDate(p.closed_at)}</td>
        <td>
          <StatusPill status={p.status} />
        </td>
        <td>
          <details className="relative">
            <summary className="btn-ghost cursor-pointer list-none">Actions ▾</summary>
            <div className="absolute right-0 z-10 mt-1 w-80 space-y-3 rounded-lg border border-border bg-surface p-3 shadow-lg">
              {p.status === "open" && p.instrument === "option" && (
                <>
                  <ActionForm title="Buy back / close" action={closeTradeAction} p={p} back={back} today={today}>
                    <Field name="price" label="Price / share" required />
                    <Field name="quantity" label={`Contracts (of ${num(p.open_quantity)})`} placeholder={String(p.open_quantity)} />
                    <Field name="fees" label="Fees" placeholder="0" />
                  </ActionForm>
                  <ActionForm title="Roll" action={rollTradeAction} p={p} back={back} today={today}>
                    <Field name="close_price" label="Buy back @" required />
                    <Field name="new_price" label="New premium @" required />
                    <Field name="new_strike" label="New strike" placeholder={String(p.strike)} required />
                    <Field name="new_expiration" label="New expiration" type="date" required />
                    <Field name="quantity" label="Contracts" placeholder={String(p.open_quantity)} />
                    <Field name="fees" label="Fees" placeholder="0" />
                  </ActionForm>
                  <div className="flex gap-2">
                    <QuickForm action={expireTradeAction} p={p} back={back} label="Expired worthless" />
                    <QuickForm action={assignTradeAction} p={p} back={back} label="Assigned" />
                  </div>
                </>
              )}
              {p.status === "open" && p.instrument === "stock" && (
                <ActionForm title="Sell shares" action={closeTradeAction} p={p} back={back} today={today}>
                  <Field name="price" label="Price / share" required />
                  <Field name="quantity" label={`Shares (of ${num(p.open_quantity)})`} placeholder={String(p.open_quantity)} />
                </ActionForm>
              )}
              <form action={updatePositionAction} className="space-y-2 border-t border-border pt-3">
                <input type="hidden" name="position_id" value={p.id} />
                <input type="hidden" name="back" value={back} />
                <label className="label">Stream</label>
                <select name="stream_id" defaultValue={p.stream_id} className="input">
                  {streams.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <input name="notes" defaultValue={p.notes ?? ""} placeholder="Notes" className="input" />
                <button className="btn-ghost">Save</button>
              </form>
              <form action={deletePositionAction} className="border-t border-border pt-3">
                <input type="hidden" name="position_id" value={p.id} />
                <input type="hidden" name="back" value={back} />
                <button className="text-xs text-loss hover:underline">Delete position and its transactions</button>
              </form>
            </div>
          </details>
        </td>
      </tr>
      {p.notes && (
        <tr>
          <td colSpan={10} className="pt-0 text-xs text-muted">
            {p.notes}
          </td>
        </tr>
      )}
    </>
  );
}

function ActionForm({
  title,
  action,
  p,
  back,
  today,
  children,
}: {
  title: string;
  action: (f: FormData) => Promise<void>;
  p: PositionRow;
  back: string;
  today: string;
  children: React.ReactNode;
}) {
  return (
    <form action={action} className="space-y-2">
      <div className="text-xs font-semibold">{title}</div>
      <input type="hidden" name="position_id" value={p.id} />
      <input type="hidden" name="back" value={back} />
      <div className="grid grid-cols-2 gap-2">
        {children}
        <Field name="date" label="Date" type="date" defaultValue={today} required />
      </div>
      <button className="btn">{title}</button>
    </form>
  );
}

function QuickForm({
  action,
  p,
  back,
  label,
}: {
  action: (f: FormData) => Promise<void>;
  p: PositionRow;
  back: string;
  label: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="position_id" value={p.id} />
      <input type="hidden" name="back" value={back} />
      <button className="btn-ghost">{label}</button>
    </form>
  );
}

function Field({
  name,
  label,
  type = "text",
  ...rest
}: { name: string; label: string; type?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="label">{label}</label>
      <input name={name} type={type} inputMode={type === "text" ? "decimal" : undefined} className="input" {...rest} />
    </div>
  );
}
