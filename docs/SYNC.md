# Robinhood sync playbook

These are the steps for the weekly scheduled Claude run, or a manual one. Work from the repo root (`E:\Powerwheel`).

**Use only read tools on the Robinhood connector. Never place, cancel or replace orders.**

Accounts tracked:

| PowerWheel account | Robinhood `account_ref` |
|---|---|
| Individual | shown by `npm run sync -- status` |
| Joint | shown by `npm run sync -- status` |

The Roth IRA and the "Agentic" account are **not** tracked.

## 1. Check state

```bash
npm run sync -- status
```

This prints three things:
- the last synced event and last snapshot per account
- any open options past expiration (the import below settles these)
- account refs (use these as `account_number` in the connector calls)

Set **SINCE** to the date of the last synced event minus 3 days. Overlap is fine; re-imported items are skipped.

## 2. Pull from Robinhood (for each account)

1. `get_option_orders(account_number, state="filled", created_at_gte=SINCE)`
   - Follow `next` cursors until the list is exhausted.
   - If a result gets saved to a file (large results do), put that file path in `order_files`.
   - Otherwise paste the `orders` array into `orders`, unchanged.
2. `get_pnl_trade_history(account_number, span="month")`. Use `3month` if SINCE is more than 30 days ago. From its rows, fill three lists:
   - `side == ""` and `price == "0"` → **`expirations`**: `{ "date": <ET date of timestamp>, "symbol", "quantity": <number> }`
   - `side == ""` and `price > 0` with a whole-hundred quantity at 4 pm ET on an expiration day → **`call_aways`**: `{ "timestamp", "symbol", "quantity", "price" }` (shares called away by a covered call)
   - `side == "sell"` and `price > 0` → **`stock_sales`**: `{ "timestamp", "symbol", "quantity", "price" }`
   - Ignore everything else. Rows with `side "buy"`, or `side ""` with a negative price, are option closes and rolls, which the orders already cover.
3. Set `expirations_from` to the first day covered by that P&L span, e.g. 30 days ago for `month`.

   For an option expiring on or after that date that's still open at expiry:
   - if a P&L expiration row covers it, the script marks it **expired**
   - if not, it marks it **assigned** (a put opens a share lot at the strike; a call sells shares)
4. `get_portfolio(account_number)` gives an account snapshot: `total_value` and `cash`.
   - **Joint only:** also add two stream snapshots.
     - `"stream": "tesla"`: `total_value` = the TSLA share value (`equity_value`, as long as TSLA is the only stock in Joint)
     - `"stream": "joint"`: `total_value` = `cash` (the capital securing Joint CSPs)
   - If you know of deposits or withdrawals since the last snapshot, put the net amount in `net_deposits`.

## 3. Write the import file and run it

Save to `sync/inbox/<YYYY-MM-DD>.json` (git-ignored):

```json
{
  "accounts": [
    {
      "account_ref": "<individual ref>",
      "order_files": [],
      "orders": [],
      "expirations_from": "2026-08-28",
      "expirations": [{ "date": "2026-09-25", "symbol": "ASTS", "quantity": 8 }],
      "call_aways": [],
      "stock_sales": [{ "timestamp": "2026-08-31T14:12:05Z", "symbol": "IREN", "quantity": 600, "price": 35.79 }]
    },
    { "account_ref": "<joint ref>", "orders": [], "expirations_from": "2026-08-28", "expirations": [], "call_aways": [], "stock_sales": [] }
  ],
  "settle": { "before": "<today YYYY-MM-DD>", "default": "skip" },
  "snapshots": [
    { "account_ref": "<individual ref>", "as_of": "<today>", "total_value": 0, "cash": 0 },
    { "account_ref": "<joint ref>", "as_of": "<today>", "total_value": 0, "cash": 0 },
    { "account_ref": "<joint ref>", "stream": "tesla", "as_of": "<today>", "total_value": 0 },
    { "account_ref": "<joint ref>", "stream": "joint", "as_of": "<today>", "total_value": 0 }
  ]
}
```

```bash
npm run sync -- import sync/inbox/<YYYY-MM-DD>.json
npm run sync -- status
```

## 4. Check the result, then report back

- `status` should list **no** open options past expiration, except ones expiring today that Robinhood hasn't settled yet.
- Open options in PowerWheel should match `get_option_positions(account_number, nonzero=true)`.
- Summarise what was imported, and list **every warning** from the script.
  - "No open position to close" means an order closed something that isn't in the database.
  - "Sold N sh but only M were tracked wheel shares" is normal when you sell shares you owned before wheeling them.

## How things map

| Robinhood | PowerWheel |
|---|---|
| order leg `sell` + `open` | new position (CSP for puts, CC for calls) + `sell_to_open` |
| order leg `buy` + `close` | `buy_to_close` on the oldest open lot(s) of that contract |
| one order with both close and open legs | **roll**: legs share `roll_group_id`; the new position joins the old chain |
| P&L row, price 0 | contract expired worthless |
| still open after expiry, no expiry row | assigned (put → share lot at strike; call → shares sold at strike) |
| P&L share sale | closes wheel share lots, oldest first |

New positions are sorted into streams by the rules on the Settings page. For example, Joint + TSLA calls/shares go to Tesla CC.

## Backfill notes (2026-09-27)

- **What was imported:** the full history from Oct 2025 (Individual) and Nov 2025 (Joint), from `sync/inbox/backfill/`.
  - Individual expirations before 2025-11-03 were settled using the "Assigned?" column in Kyle's sheet.
  - Everything after that was settled from the Robinhood P&L history.
- **Check against Robinhood:** weekly realized option P&L matches `get_realized_pnl` to the dollar for Joint.
  - Individual is within $152 for the whole year. Most of that is a small LDI long option and an OPEN corporate-action adjustment.
- **Share P&L is approximate for shares owned before wheeling** (e.g. PLTR, NFE). Only shares that came from assignments are tracked.
