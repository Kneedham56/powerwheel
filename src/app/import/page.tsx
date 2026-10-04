import { PageTitle } from "@/components/ui";
import { loadAll } from "@/lib/db";
import { ImportForm } from "./ImportForm";

// a long history imports in steps of ~40s each; this lets one step run that long
export const maxDuration = 60;

export default async function ImportPage() {
  const { accounts } = await loadAll();
  return (
    <div className="space-y-6">
      <PageTitle>Import from Robinhood</PageTitle>

      <section className="card space-y-2 text-sm">
        <h2 className="font-medium">How to get the file</h2>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>In Robinhood, open the account, then <b>Reports and statements</b>.</li>
          <li>
            Choose <b>Account activity report</b> → <b>Generate new report</b>, pick the account, and set the start date
            to when you want tracking to begin (earlier is better) through today.
          </li>
          <li>It usually takes a couple of hours. When it&apos;s ready, download the CSV and upload it below.</li>
        </ol>
        <p className="text-muted">
          One file is one account. Upload a new report whenever you like: anything already imported is skipped, so
          overlapping dates are fine. Rolls are inferred from same-day trades, so a few may be grouped differently
          than in Robinhood. Interest, deposits and shares you bought yourself aren&apos;t tracked.
        </p>
      </section>

      <ImportForm accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
    </div>
  );
}
