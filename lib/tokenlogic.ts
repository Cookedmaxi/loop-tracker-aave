// TokenLogic API (https://api.tokenlogic.xyz).
// - /v1/public/interest-rates/*: no key. Deposit and borrow rates per market and symbol.
// - /v1/aave/*: needs TOKENLOGIC_API_KEY (Unkey key with the client.api permission),
//   sent as "Authorization: Bearer <key>". Ask martin@tokenlogic.xyz for one.
// Every answer is { data, lastUpdated }.

import type { Address } from "@/config/assets";

const BASE = process.env.TOKENLOGIC_API_URL ?? "https://api.tokenlogic.xyz";

export const hasTokenLogicKey = () => Boolean(process.env.TOKENLOGIC_API_KEY);

async function get<T>(path: string, auth: boolean): Promise<{ data: T; lastUpdated: string | null }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth) {
    const key = process.env.TOKENLOGIC_API_KEY;
    if (!key) throw new Error("TOKENLOGIC_API_KEY is not set");
    headers.authorization = `Bearer ${key}`;
  }
  const res = await fetch(`${BASE}${path}`, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (res.status === 401) throw new Error("TokenLogic API: missing or invalid API key (401)");
  if (res.status === 403) throw new Error("TokenLogic API: the key lacks the client.api permission (403)");
  if (!res.ok) throw new Error(`TokenLogic API answered ${res.status} for ${path}`);
  const body = await res.json();
  return { data: body.data as T, lastUpdated: body.lastUpdated ?? null };
}

// ── public interest rates (no key) ──────────────────────────────────────────

export interface RateRow {
  timestamp: string; chain: string | null; market: string | null; symbol: string | null; rate_type: string | null;
  deposit_apr: number | null; deposit_apy: number | null; borrow_apr: number | null; borrow_apy: number | null;
}

/** Latest-day rate for a symbol on a market (e.g. "Aave V3" on "ethereum" = Ethereum Core). Rates are decimals. */
export async function latestRate(symbol: string, market: string, chain: string): Promise<RateRow | null> {
  const q = new URLSearchParams({ symbol, market, chain, rate_type: "Protocol" });
  const { data } = await get<RateRow[]>(`/v1/public/interest-rates/latest?${q}`, false);
  return data[0] ?? null;
}

/** Daily rate history for a symbol on a market, oldest first. */
export async function dailyRates(symbol: string, market: string, chain: string, from: string): Promise<RateRow[]> {
  const q = new URLSearchParams({ symbol, market, chain, rate_type: "Protocol", from });
  const { data } = await get<RateRow[]>(`/v1/public/interest-rates/daily?${q}`, false);
  return [...data].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ── Aave data (key) ─────────────────────────────────────────────────────────

export interface ReserveRow {
  market_key: string; reserve_address: string; reserve_symbol: string;
  deposits: number; borrows: number; available_liquidity: number; utilization: number;
  borrow_apy: number; supply_apy: number; reserve_price: number;
}

const toRow = (r: any): ReserveRow => ({
  ...r, deposits: Number(r.deposits), borrows: Number(r.borrows), available_liquidity: Number(r.available_liquidity),
  utilization: Number(r.utilization), borrow_apy: Number(r.borrow_apy), supply_apy: Number(r.supply_apy), reserve_price: Number(r.reserve_price),
});
const describe = (d: unknown) => Array.isArray(d) ? `array of ${d.length}${d[0] ? ` (fields: ${Object.keys(d[0]).slice(0, 8).join(", ")})` : ""}` : d && typeof d === "object" ? `object (fields: ${Object.keys(d).slice(0, 8).join(", ")})` : String(d);
const matches = (r: any, reserve: string) => [r?.reserve_address, r?.reserve, r?.underlying_asset, r?.address].some((a) => typeof a === "string" && a.toLowerCase() === reserve.toLowerCase());

/**
 * Current data for one reserve of a market, e.g. ("ethereum-core-v3", rsETH address).
 * Tries the address in lowercase, then as given, then the market's full reserve list.
 * `tried` says what each attempt returned, for the Data tab.
 */
export async function reserveLatest(marketKey: string, reserve: Address): Promise<{ row: ReserveRow | null; lastUpdated: string | null; tried: string[] }> {
  const tried: string[] = [];
  const paths = [...new Set([`/v1/aave/reserves/${marketKey}/${reserve.toLowerCase()}/latest`, `/v1/aave/reserves/${marketKey}/${reserve}/latest`])];
  for (const path of paths) {
    try {
      const { data, lastUpdated } = await get<any>(path, true);
      const row = Array.isArray(data) ? data.find((r) => matches(r, reserve)) ?? data[0] : data;
      if (row && row.deposits !== undefined) return { row: toRow(row), lastUpdated, tried };
      tried.push(`${path} → ${describe(data)}`);
    } catch (e) { tried.push(`${path} → ${e instanceof Error ? e.message : "failed"}`); if (e instanceof Error && /401|403/.test(e.message)) throw e; }
  }
  try {
    const path = `/v1/aave/reserves/${marketKey}/latest`;
    const { data, lastUpdated } = await get<any>(path, true);
    const list = Array.isArray(data) ? data : Array.isArray(data?.reserves) ? data.reserves : [];
    const row = list.find((r: any) => matches(r, reserve));
    if (row && row.deposits !== undefined) return { row: toRow(row), lastUpdated, tried };
    tried.push(`${path} → ${describe(data)}`);
  } catch (e) { tried.push(`/v1/aave/reserves/${marketKey}/latest → ${e instanceof Error ? e.message : "failed"}`); }
  return { row: null, lastUpdated: null, tried };
}

export interface LiquidationRow {
  timestamp: string; tx_hash: string; chain: string; market_key: string; user_liquidated: string; liquidator: string;
  collateral_symbol: string; collateral_address: string; debt_symbol: string; debt_address: string;
  collateral_amount: number; collateral_usd: number; debt_amount: number; debt_usd: number; liquidator_profit_usd: number;
}

/** Recent liquidations on a market, newest first. */
export async function liquidations(marketKey: string, from?: string, limit = 2000): Promise<LiquidationRow[]> {
  const q = new URLSearchParams({ market_key: marketKey, limit: String(limit), ...(from ? { from } : {}) });
  const { data } = await get<LiquidationRow[]>(`/v1/aave/liquidations/txns?${q}`, true);
  return [...data].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}
