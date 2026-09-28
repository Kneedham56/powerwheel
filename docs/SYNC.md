# Robinhood sync playbook

Steps for a scheduled or manual sync. Run everything from the repo root.

**Use only read tools on the Robinhood connector. Never place, cancel or replace orders.**

All the logic lives in `scripts/sync.ts`. Your job is to fetch four things per account, save them, and run one command.

## 1. Setup and status

```bash
npm ci            # only if node_modules is missing (cloud sessions)
npm run sync -- status
```

For each tracked account, `status` prints its `account_ref` and a `since` date. Only Individual and Joint are tracked. Ignore the Roth IRA and the "Agentic" account.

## 2. Fetch (for each account)

| Call | Arguments |
|---|---|
| `get_option_orders` | `account_number=<account_ref>`, `state="filled"`, `created_at_gte=<since>`. Follow `next` cursors until empty. |
| `get_pnl_trade_history` | `account_number=<account_ref>`, `span="month"` |
| `get_portfolio` | `account_number=<account_ref>` |

## 3. Write `sync/inbox/<today>.json`

```json
{
  "accounts": [
    {
      "account_ref": "<ref>",
      "order_files": [],
      "orders": [],
      "pnl": {},
      "portfolio": {}
    }
  ]
}
```

- **`orders`:** if a tool result was saved to a file (large results are), list that path in `order_files` and don't copy it. Otherwise put the orders in `orders`. To save tokens, copy only these fields; the script ignores the rest:
  - order: `id`, `chain_symbol`, `state`, `created_at`, `legs`
  - leg: `id`, `option_id`, `side`, `position_effect`, `expiration_date`, `strike_price`, `option_type`, `executions`
  - execution: `price`, `quantity`, `timestamp`
- **`pnl` and `portfolio`:** paste the responses unchanged. If a response was saved to a file, use `pnl_files: ["<path>"]` instead.

Don't interpret anything. The script does that:
- It sorts P&L rows into expirations, called-away shares and share sales.
- It settles expirations vs assignments.
- It records the account snapshot, plus the Tesla CC and Joint Wheel stream values for Joint.

## 4. Import and verify

```bash
npm run sync -- import sync/inbox/<today>.json
npm run sync -- status
```

`status` should show **0** open options past expiration.

## 5. Report

Give a short summary: trades imported per account, snapshot values, and **every warning, word for word**. Keep it brief.

If the import fails, report the error and stop. Don't retry with different data, and don't edit code.

## Reference

How Robinhood data maps (implemented in `scripts/sync.ts`):

| Robinhood | PowerWheel |
|---|---|
| order leg `sell` + `open` | new position (CSP for puts, CC for calls) |
| order leg `buy` + `close` | buyback on the oldest open lot(s) of that contract |
| one order with close and open legs | **roll**: both legs join the same trade chain |
| P&L row: blank side, price 0 | expired worthless |
| still open after expiry, no such row | assigned (put → share lot at strike; call → shares sold) |
| P&L row: blank side, price > 0 | shares called away by a covered call |
| P&L row: side `sell`, price > 0 | shares sold; closes wheel share lots, oldest first |

Imports are idempotent: every event stores a broker reference, so overlapping pulls are skipped. Positions go to streams by the rules in Settings. Stream snapshots are configured in `STREAM_SNAPSHOTS` in `scripts/sync.ts`.

## Backfill notes (2026-09-27)

- **What was imported:** full history from Oct 2025 (Individual) and Nov 2025 (Joint).
  - Individual expirations before 2025-11-03 were settled from the "Assigned?" column in Kyle's sheet.
  - Everything later was settled from Robinhood's P&L history.
- **Check against Robinhood:** weekly realized option P&L matches `get_realized_pnl` to the dollar for Joint, and within $152 for the year for Individual.
- **Share P&L** is approximate for shares owned before wheeling. Only assignment-created share lots are tracked.
