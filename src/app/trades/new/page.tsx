import { openTradeAction } from "@/app/actions";
import { Flash, PageTitle } from "@/components/ui";
import { loadAll } from "@/lib/db";
import { todayEt } from "@/lib/reports";

/** Next Friday (or today if it's Friday) — the usual weekly expiration. */
function nextFriday(today: string) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

export default async function NewTradePage({ searchParams }: PageProps<"/trades/new">) {
  const sp = await searchParams;
  const { accounts, streams } = await loadAll();
  const today = todayEt();

  return (
    <div className="max-w-2xl">
      <Flash sp={sp} />
      <PageTitle>New trade</PageTitle>
      <form action={openTradeAction} className="card grid grid-cols-2 gap-4 md:grid-cols-3">
        <input type="hidden" name="back" value="/trades/new" />

        <div>
          <label className="label">Type</label>
          <select name="kind" className="input" defaultValue="CSP">
            <option value="CSP">Sell put (CSP)</option>
            <option value="CC">Sell call (CC)</option>
            <option value="STOCK">Buy shares</option>
          </select>
        </div>
        <div>
          <label className="label">Account</label>
          <select name="account_id" className="input" required>
            {accounts
              .filter((a) => a.is_active)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="label">Stream</label>
          <select name="stream_id" className="input" defaultValue="">
            <option value="">Auto (stream rules)</option>
            {streams
              .filter((s) => s.is_active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>

        <div>
          <label className="label">Ticker</label>
          <input name="ticker" className="input uppercase" required autoFocus />
        </div>
        <div>
          <label className="label">Strike (options)</label>
          <input name="strike" className="input" inputMode="decimal" />
        </div>
        <div>
          <label className="label">Expiration (options)</label>
          <input name="expiration" type="date" className="input" defaultValue={nextFriday(today)} />
        </div>

        <div>
          <label className="label">Contracts / shares</label>
          <input name="quantity" className="input" inputMode="numeric" required />
        </div>
        <div>
          <label className="label">Price per share (premium)</label>
          <input name="price" className="input" inputMode="decimal" required placeholder="e.g. 1.23" />
        </div>
        <div>
          <label className="label">Fees</label>
          <input name="fees" className="input" inputMode="decimal" placeholder="0" />
        </div>

        <div>
          <label className="label">Trade date</label>
          <input name="date" type="date" className="input" defaultValue={today} required />
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <input name="notes" className="input" />
        </div>

        <div className="col-span-full flex items-center justify-between">
          <p className="text-xs text-muted">
            Premium is per share, like the option chain shows it: 3 contracts at $1.23 = $369.
          </p>
          <button className="btn">Save trade</button>
        </div>
      </form>
    </div>
  );
}
