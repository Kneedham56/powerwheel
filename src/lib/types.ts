export type Instrument = "option" | "stock";
export type OptionType = "put" | "call";
export type Strategy = "CSP" | "CC" | "STOCK" | "OTHER";
export type PositionStatus = "open" | "closed" | "expired" | "assigned" | "rolled";
export type TxnAction =
  | "sell_to_open"
  | "buy_to_close"
  | "buy_to_open"
  | "sell_to_close"
  | "expire"
  | "assign"
  | "buy"
  | "sell";
export type Source = "manual" | "sync" | "import";

export interface Account {
  id: string;
  name: string;
  broker: string;
  broker_account_ref: string | null;
  is_active: boolean;
}

export interface Stream {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface StreamRule {
  id: string;
  stream_id: string;
  account_id: string | null;
  ticker: string | null;
  kind: "put" | "call" | "stock" | null;
  priority: number;
}

/** Row of the v_positions view. */
export interface PositionRow {
  id: string;
  account_id: string;
  stream_id: string;
  instrument: Instrument;
  ticker: string;
  option_type: OptionType | null;
  side: "short" | "long";
  strike: number | null;
  expiration: string | null;
  strategy: Strategy;
  status: PositionStatus;
  opened_at: string;
  closed_at: string | null;
  rolled_from_id: string | null;
  chain_id: string;
  assigned_from_id: string | null;
  notes: string | null;
  /** stock close on expiration day; set only for assigned options (see docs/SYNC.md) */
  underlying_close: number | null;
  account_name: string;
  stream_name: string;
  stream_slug: string;
  stream_color: string | null;
  quantity: number;
  open_quantity: number;
  open_price: number | null;
  close_price: number | null;
  credits: number;
  debits: number;
  fees: number;
  net_amount: number;
  collateral: number | null;
  week_start: string;
}

/** Row of the v_transactions view. */
export interface TransactionRow {
  id: string;
  position_id: string;
  occurred_at: string;
  action: TxnAction;
  quantity: number;
  price: number;
  fees: number;
  amount: number;
  roll_group_id: string | null;
  broker_ref: string | null;
  source: Source;
  notes: string | null;
  account_id: string;
  stream_id: string;
  ticker: string;
  instrument: Instrument;
  option_type: OptionType | null;
  strategy: Strategy;
  strike: number | null;
  expiration: string | null;
  chain_id: string;
  account_name: string;
  stream_name: string;
}

export interface Snapshot {
  id: string;
  account_id: string;
  stream_id: string | null;
  as_of: string;
  total_value: number;
  cash: number | null;
  net_deposits: number;
  source: Source;
  notes: string | null;
}
