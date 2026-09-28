import {
  addRuleAction,
  deleteRuleAction,
  reapplyRulesAction,
  saveAccountAction,
  saveStreamAction,
} from "@/app/actions";
import { Flash, PageTitle, StreamDot } from "@/components/ui";
import { loadAll } from "@/lib/db";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const sp = await searchParams;
  const { accounts, streams, rules } = await loadAll();
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const stream = new Map(streams.map((s) => [s.id, s]));

  return (
    <div className="space-y-6">
      <Flash sp={sp} />
      <PageTitle>Settings</PageTitle>

      <section className="card space-y-3">
        <h2 className="font-medium">Streams</h2>
        <p className="text-sm text-muted">
          Streams are reporting buckets. Every position belongs to exactly one. Add as many as you like.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Description</th>
              <th>Color</th>
              <th>Order</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {streams.map((s) => (
              <tr key={s.id}>
                <td colSpan={7} className="p-0">
                  <form action={saveStreamAction} className="grid grid-cols-[1.2fr_1fr_2fr_70px_60px_50px_70px] items-center gap-2 px-2 py-1.5">
                    <input type="hidden" name="id" value={s.id} />
                    <input name="name" defaultValue={s.name} className="input" />
                    <input name="slug" defaultValue={s.slug} className="input" />
                    <input name="description" defaultValue={s.description ?? ""} className="input" />
                    <input name="color" type="color" defaultValue={s.color ?? "#888888"} className="h-8 w-full" />
                    <input name="sort_order" defaultValue={s.sort_order} className="input" />
                    <input name="is_active" type="checkbox" defaultChecked={s.is_active} />
                    <button className="btn-ghost">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={saveStreamAction} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">New stream</label>
            <input name="name" className="input" placeholder="e.g. Earnings plays" required />
          </div>
          <div className="w-64">
            <label className="label">Description</label>
            <input name="description" className="input" />
          </div>
          <input name="color" type="color" defaultValue="#8a63d2" className="h-8 w-12" />
          <button className="btn">Add stream</button>
        </form>
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium">Stream rules</h2>
        <p className="text-sm text-muted">
          New positions (manual or synced) are assigned to the most specific matching rule; lower priority number wins.
          Blank = matches anything. You can always override a single position from the Positions page.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Priority</th>
              <th>Account</th>
              <th>Ticker</th>
              <th>Kind</th>
              <th>→ Stream</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.priority}</td>
                <td>{r.account_id ? accountName.get(r.account_id) : <span className="text-muted">any</span>}</td>
                <td>{r.ticker ?? <span className="text-muted">any</span>}</td>
                <td>{r.kind ?? <span className="text-muted">any</span>}</td>
                <td>
                  <StreamDot color={stream.get(r.stream_id)?.color} />
                  {stream.get(r.stream_id)?.name}
                </td>
                <td>
                  <form action={deleteRuleAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <button className="text-xs text-loss hover:underline">remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addRuleAction} className="flex flex-wrap items-end gap-2">
          <div className="w-20">
            <label className="label">Priority</label>
            <input name="priority" defaultValue="50" className="input" />
          </div>
          <div>
            <label className="label">Account</label>
            <select name="account_id" className="input">
              <option value="">any</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="w-24">
            <label className="label">Ticker</label>
            <input name="ticker" className="input uppercase" />
          </div>
          <div>
            <label className="label">Kind</label>
            <select name="kind" className="input">
              <option value="">any</option>
              <option value="put">put</option>
              <option value="call">call</option>
              <option value="stock">stock</option>
            </select>
          </div>
          <div>
            <label className="label">Stream</label>
            <select name="stream_id" className="input" required>
              {streams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn">Add rule</button>
        </form>
        <form action={reapplyRulesAction}>
          <button className="btn-ghost">Re-apply rules to all existing positions</button>
        </form>
      </section>

      <section className="card space-y-3">
        <h2 className="font-medium">Accounts</h2>
        <p className="text-sm text-muted">
          Broker account number lets the Robinhood sync match orders to the right account.
        </p>
        {accounts.map((a) => (
          <form key={a.id} action={saveAccountAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={a.id} />
            <div>
              <label className="label">Name</label>
              <input name="name" defaultValue={a.name} className="input" />
            </div>
            <div>
              <label className="label">Broker account #</label>
              <input name="broker_account_ref" defaultValue={a.broker_account_ref ?? ""} className="input" />
            </div>
            <label className="flex items-center gap-1 pb-2 text-sm">
              <input name="is_active" type="checkbox" defaultChecked={a.is_active} /> active
            </label>
            <button className="btn-ghost">Save</button>
          </form>
        ))}
        <form action={saveAccountAction} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div>
            <label className="label">New account</label>
            <input name="name" className="input" required />
          </div>
          <div>
            <label className="label">Broker account #</label>
            <input name="broker_account_ref" className="input" />
          </div>
          <button className="btn">Add account</button>
        </form>
      </section>
    </div>
  );
}
