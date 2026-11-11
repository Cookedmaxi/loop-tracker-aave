// Aave actions read from the chain: the Pool's own Supply, Withdraw, Borrow, Repay and
// LiquidationCall events. Unlike token transfers, they give the exact action, the exact
// amount (no accrued interest mixed in), who acted for whom, and the block's time.
//
// The history is read once and saved; afterwards only new blocks are read (a few calls a
// minute). RPC providers cap how many blocks one eth_getLogs may span: the lookback is read
// in windows of LOGS_BLOCK_RANGE blocks, and a window the provider refuses is split in two.

import { formatUnits, parseAbi, parseAbiItem, parseEventLogs, toEventSelector } from "viem";
import { AAVE_V3_CORE, type Address } from "@/config/assets";
import { client, type Reserve } from "./chain";
import { hget, hkeys, hset, storageKind } from "./store";

const EVENTS = {
  Supply: parseAbiItem("event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)"),
  Withdraw: parseAbiItem("event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)"),
  Borrow: parseAbiItem("event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"),
  Repay: parseAbiItem("event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)"),
  LiquidationCall: parseAbiItem("event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"),
};
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

export interface AaveEvent {
  txHash: string; logIndex: number; block: number; timestamp: string;
  action: "Supply" | "Withdraw" | "Borrow" | "Repay" | "Liquidation";
  wallet: Address;              // whose position changed
  counterparty: Address | null; // who acted for them, received the funds, or liquidated them
  reserve: Address; symbol: string; amount: number;
  extra?: string;               // liquidation: collateral seized
}

const LOOKBACK = Number(process.env.AAVE_EVENTS_LOOKBACK_BLOCKS ?? 216_000); // about 30 days
const RANGE = Number(process.env.LOGS_BLOCK_RANGE ?? 0); // 0: ask for the whole span, split only if refused

const tokenInfo = new Map<string, Promise<{ symbol: string; decimals: number }>>();
function info(token: Address) {
  const k = token.toLowerCase();
  if (!tokenInfo.has(k)) {
    const c = client();
    tokenInfo.set(k, Promise.all([
      c.readContract({ address: token, abi: erc20, functionName: "symbol" }).catch(() => "?"),
      c.readContract({ address: token, abi: erc20, functionName: "decimals" }).catch(() => 18),
    ]).then(([symbol, decimals]) => ({ symbol: String(symbol), decimals: Number(decimals) })));
  }
  return tokenInfo.get(k)!;
}

const blockTimes = new Map<bigint, Promise<string>>();
function timeOf(block: bigint): Promise<string> {
  if (!blockTimes.has(block)) blockTimes.set(block, client().getBlock({ blockNumber: block }).then((b) => new Date(Number(b.timestamp) * 1000).toISOString()));
  return blockTimes.get(block)!;
}

type Filter = { reserves: Reserve; wallets?: Address[]; collateralOnly?: boolean };

const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
const SIG = Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, toEventSelector(v)])) as Record<keyof typeof EVENTS, `0x${string}`>;
const ABI = Object.values(EVENTS);

// Learned from the provider's refusal message (e.g. "up to a 500 block range").
let maxSpan: number | null = RANGE > 0 ? RANGE : null;

class SpanTooWide extends Error {}

async function rawLogs(from: bigint, to: bigint, topics: (`0x${string}` | `0x${string}`[] | null)[]): Promise<any[]> {
  try {
    return await client().request({
      method: "eth_getLogs",
      params: [{ address: AAVE_V3_CORE.pool, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics }],
    } as any) as any[];
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${(e as any).details ?? ""}` : String(e);
    if (!/range|limit|too many|exceed|large|response size|10000|results/i.test(msg)) throw e;
    const n = msg.match(/(\d[\d,]*)\s*block/i)?.[1];
    if (n) { const v = Number(n.replace(/,/g, "")); if (v > 0 && v < Number(to - from + 1n)) maxSpan = v; }
    throw new SpanTooWide(msg);
  }
}

/**
 * Two eth_getLogs per span: Supply, Withdraw, Borrow and Repay share their layout (reserve
 * in topic 1, the wallet in topic 2), so one call reads all four; liquidations are the other.
 * A span the provider refuses is split in two.
 */
async function logsIn(f: Filter, from: bigint, to: bigint): Promise<any[]> {
  const assets = (f.collateralOnly ? [f.reserves.underlying] : [f.reserves.underlying, f.reserves.debtUnderlying]).map(pad);
  const users = f.wallets?.length ? f.wallets.map(pad) : null;
  try {
    const [actions, liq] = await Promise.all([
      rawLogs(from, to, [[SIG.Supply, SIG.Withdraw, SIG.Borrow, SIG.Repay], assets, users]),
      rawLogs(from, to, [SIG.LiquidationCall, pad(f.reserves.underlying), null, users]),
    ]);
    return parseEventLogs({ abi: ABI, logs: [...actions, ...liq] });
  } catch (e) {
    if (!(e instanceof SpanTooWide) || to - from < 10n) throw e;
    const span = maxSpan && maxSpan < Number(to - from + 1n) ? BigInt(maxSpan) : (to - from + 1n) / 2n;
    const parts: [bigint, bigint][] = [];
    for (let s = from; s <= to; s += span) parts.push([s, s + span - 1n > to ? to : s + span - 1n]);
    return (await pooled(parts.map(([a, b]) => () => logsIn(f, a, b)), 4)).flat();
  }
}

/** Runs tasks with at most `n` at a time. */
async function pooled<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

async function toEvent(l: any): Promise<AaveEvent> {
  const a = l.args;
  const base = { txHash: l.transactionHash, logIndex: Number(l.logIndex), block: Number(l.blockNumber), timestamp: await timeOf(BigInt(l.blockNumber)) };
  if (l.eventName === "LiquidationCall") {
    const [debt, coll] = await Promise.all([info(a.debtAsset), info(a.collateralAsset)]);
    return { ...base, action: "Liquidation", wallet: a.user, counterparty: a.liquidator, reserve: a.debtAsset, symbol: debt.symbol,
      amount: Number(formatUnits(a.debtToCover, debt.decimals)), extra: `${Number(formatUnits(a.liquidatedCollateralAmount, coll.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${coll.symbol} seized` };
  }
  const t = await info(a.reserve);
  const amount = Number(formatUnits(a.amount, t.decimals));
  const wallet: Address = l.eventName === "Supply" || l.eventName === "Borrow" ? a.onBehalfOf : a.user;
  const other: Address | null = l.eventName === "Supply" || l.eventName === "Borrow" ? a.user : l.eventName === "Withdraw" ? a.to : a.repayer;
  return { ...base, action: l.eventName, wallet, counterparty: other && other.toLowerCase() !== wallet.toLowerCase() ? other : null, reserve: a.reserve, symbol: t.symbol, amount };
}

/** Aave events over a block span: in one go when the provider allows it, else in learned chunks. */
async function readRange(f: Filter, from: bigint, to: bigint): Promise<AaveEvent[]> {
  const parts: [bigint, bigint][] = [];
  const span = BigInt(maxSpan ?? Number(to - from + 1n));
  for (let s = from; s <= to; s += span) parts.push([s, s + span - 1n > to ? to : s + span - 1n]);
  const logs = (await pooled(parts.map(([a, b]) => () => logsIn(f, a, b)), 4)).flat();
  return pooled(logs.map((l) => () => toEvent(l)), 8);
}

const newest = (x: AaveEvent, y: AaveEvent) => y.block - x.block || y.logIndex - x.logIndex;
const keyOf = (e: AaveEvent) => `${e.txHash}:${e.logIndex}`;

// ── Saved events ─────────────────────────────────────────────────────────────
// The history is read once, then each visit reads only the blocks mined since. Saved in
// shared storage (Upstash) when it is set up, otherwise in this server instance's memory.

interface Saved { lastBlock: number; wallets: string[]; events: AaveEvent[] }
const HASH = "aave-events";
const memory = new Map<string, Saved>();

async function load(key: string): Promise<Saved | null> {
  if (storageKind() !== "none") {
    try { const raw = await hget(HASH, key); if (raw) return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { /* fall through */ }
  }
  return memory.get(key) ?? null;
}
async function save(key: string, s: Saved) {
  memory.set(key, s);
  if (storageKind() !== "none") await hset(HASH, key, JSON.stringify(s)).catch(() => {});
}

/**
 * Aave events of a reserve over the lookback, optionally only those of the given wallets,
 * newest first. Reads only new blocks after the first call; a wallet that joins the list
 * gets its own history read once.
 */
export async function readPoolEvents(reserves: Reserve, opts: { wallets?: Address[]; lookbackBlocks?: number; collateralOnly?: boolean } = {}): Promise<AaveEvent[]> {
  const lookback = opts.lookbackBlocks ?? LOOKBACK;
  const wallets = (opts.wallets ?? []).map((w) => w.toLowerCase()).sort();
  const key = `${reserves.symbol}:${opts.collateralOnly ? "collateral" : "all"}:${opts.wallets ? "wallets" : "everyone"}:${lookback}`;
  const latest = Number(await client().getBlockNumber());
  const floor = Math.max(0, latest - lookback);
  const base: Filter = { reserves, collateralOnly: opts.collateralOnly };

  const saved = await load(key);
  const found: AaveEvent[] = [];
  let from = floor;
  if (saved && saved.lastBlock >= floor) {
    from = saved.lastBlock + 1;
    found.push(...saved.events);
    const added = opts.wallets ? wallets.filter((w) => !saved.wallets.includes(w)) : [];
    if (added.length) found.push(...await readRange({ ...base, wallets: added as Address[] }, BigInt(floor), BigInt(saved.lastBlock)));
  }
  if (from <= latest) found.push(...await readRange({ ...base, wallets: opts.wallets }, BigInt(from), BigInt(latest)));

  const seen = new Set<string>();
  const keep = new Set(wallets);
  const events = found
    .filter((e) => e.block >= floor && (!opts.wallets || keep.has(e.wallet.toLowerCase())))
    .filter((e) => !seen.has(keyOf(e)) && !!seen.add(keyOf(e)))
    .sort(newest);
  await save(key, { lastBlock: latest, wallets, events });
  return events;
}

/** What the saved event history holds, for the Data tab. */
export async function savedHistory(): Promise<{ feed: string; lastBlock: number; events: number; newest: string | null; where: string }[]> {
  const keys = new Set<string>(memory.keys());
  if (storageKind() !== "none") {
    try { for (const k of await hkeys(HASH)) keys.add(k); } catch { /* storage unreachable */ }
  }
  const out = [];
  for (const k of keys) {
    const s = await load(k);
    if (!s) continue;
    const [symbol, scope, who] = k.split(":");
    out.push({
      feed: `${symbol} · ${who === "wallets" ? "tracked holders" : scope === "collateral" ? "market" : "everyone"}`,
      lastBlock: s.lastBlock, events: s.events.length, newest: s.events[0]?.timestamp ?? null,
      where: storageKind() === "redis" ? "Upstash" : storageKind() === "file" ? "local file" : "server memory",
    });
  }
  return out;
}
