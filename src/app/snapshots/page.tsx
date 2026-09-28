import { deleteSnapshotAction, saveSnapshotAction } from "@/app/actions";
import { Flash, PageTitle } from "@/components/ui";
import { loadAll } from "@/lib/db";
import { money, shortDate } from "@/lib/format";
import { todayEt } from "@/lib/reports";

export default async function SnapshotsPage({ searchParams }: PageProps<"/snapshots">) {
  const sp = await searchParams;
  const { accounts, streams, snapshots } = await loadAll();
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const streamName = new Map(streams.map((s) => [s.id, s.name]));

  return (
    <div className="space-y-4">
      <Flash sp={sp} />
      <PageTitle>Account value</PageTitle>
      <p className="max-w-3xl text-sm text-muted">
        Snapshots of what each account is worth. Reports use the latest snapshot on or before a date as the capital base
        for return %. Weekly is plenty. Record deposits/withdrawals so they don&apos;t look like gains. Optionally set a
        stream to track capital allocated inside an account (e.g. the value of the TSLA shares behind Tesla CC).
      </p>

      <form action={saveSnapshotAction} className="card grid grid-cols-2 gap-3 md:grid-cols-7">
        <div>
          <label className="label">Account</label>
          <select name="account_id" className="input" required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Stream (optional)</label>
          <select name="stream_id" className="input" defaultValue="">
            <option value="">Whole account</option>
            {streams.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">As of</label>
          <input name="as_of" type="date" className="input" defaultValue={todayEt()} required />
        </div>
        <div>
          <label className="label">Total value</label>
          <input name="total_value" className="input" inputMode="decimal" required />
        </div>
        <div>
          <label className="label">Cash</label>
          <input name="cash" className="input" inputMode="decimal" />
        </div>
        <div>
          <label className="label">Deposits (−withdrawals)</label>
          <input name="net_deposits" className="input" inputMode="decimal" placeholder="0" />
        </div>
        <div className="flex items-end">
          <button className="btn w-full justify-center">Save</button>
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>As of</th>
              <th>Account</th>
              <th>Stream</th>
              <th className="num">Total value</th>
              <th className="num">Cash</th>
              <th className="num">Deposits</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.id}>
                <td>{shortDate(s.as_of)}</td>
                <td>{accountName.get(s.account_id)}</td>
                <td className="text-muted">{s.stream_id ? streamName.get(s.stream_id) : "—"}</td>
                <td className="num">{money(s.total_value)}</td>
                <td className="num">{money(s.cash)}</td>
                <td className="num">{s.net_deposits ? money(s.net_deposits) : ""}</td>
                <td className="text-xs text-muted">{s.source}</td>
                <td>
                  <form action={deleteSnapshotAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <button className="text-xs text-loss hover:underline">delete</button>
                  </form>
                </td>
              </tr>
            ))}
            {!snapshots.length && (
              <tr>
                <td colSpan={8} className="text-muted">
                  No snapshots yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
