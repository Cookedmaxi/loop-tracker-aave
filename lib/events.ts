// Aave actions read from the chain: the Pool's own Supply, Withdraw, Borrow, Repay and
// LiquidationCall events. Unlike token transfers, they give the exact action, the exact
// amount (no accrued interest mixed in), who acted for whom, and the block's time.
//
// The history is read once and saved; afterwards only new blocks are read (a few calls a
// minute). RPC providers cap how many blocks one eth_getLogs may span: the lookback is read
// in windows of LOGS_BLOCK_RANGE blocks, and a window the provider refuses is split in two.

import { formatUnits, parseAbi, parseAbiItem, type Log } from "viem";
import { AAVE_V3_CORE, type Address } from "@/config/assets";
import { client, type Reserve } from "./chain";
import { hget, hset, storageKind } from "./store";

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
const RANGE = Number(process.env.LOGS_BLOCK_RANGE ?? 10_000);

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

/** One eth_getLogs per event over [from, to]; halves the span when the RPC refuses it as too wide. */
async function logsIn(f: Filter, from: bigint, to: bigint): Promise<Log[]> {
  const c = client();
  const assets = f.collateralOnly ? [f.reserves.underlying] : [f.reserves.underlying, f.reserves.debtUnderlying];
  const users = f.wallets?.length ? f.wallets : undefined;
  const window = { address: AAVE_V3_CORE.pool, fromBlock: from, toBlock: to } as const;
  // A few new blocks: one call for all five events, filtered here. Cheaper than five calls.
  if (to - from <= 300n) {
    const inSet = (x: string | undefined, set?: string[]) => !set || (!!x && set.some((s) => s.toLowerCase() === x.toLowerCase()));
    const all = await c.getLogs({ ...window, events: Object.values(EVENTS) });
    return all.filter((l: any) => {
      const a = l.args;
      if (l.eventName === "LiquidationCall") return inSet(a.collateralAsset, [f.reserves.underlying]) && inSet(a.user, users);
      const who = l.eventName === "Supply" || l.eventName === "Borrow" ? a.onBehalfOf : a.user;
      return inSet(a.reserve, assets) && inSet(who, users);
    });
  }
  try {
    // One after the other: free RPC plans cap compute units per second.
    const out: Log[] = [];
    out.push(...await c.getLogs({ ...window, event: EVENTS.Supply, args: { reserve: assets, onBehalfOf: users } }));
    out.push(...await c.getLogs({ ...window, event: EVENTS.Withdraw, args: { reserve: assets, user: users } }));
    out.push(...await c.getLogs({ ...window, event: EVENTS.Borrow, args: { reserve: assets, onBehalfOf: users } }));
    out.push(...await c.getLogs({ ...window, event: EVENTS.Repay, args: { reserve: assets, user: users } }));
    out.push(...await c.getLogs({ ...window, event: EVENTS.LiquidationCall, args: { collateralAsset: f.reserves.underlying, user: users } }));
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (to - from < 10n || !/range|limit|too many|exceed|large|10000|response size/i.test(msg)) throw e;
    const mid = from + (to - from) / 2n;
    return [...await logsIn(f, from, mid), ...await logsIn(f, mid + 1n, to)];
  }
}

async function toEvent(l: any): Promise<AaveEvent> {
  const a = l.args;
  const base = { txHash: l.transactionHash, logIndex: Number(l.logIndex), block: Number(l.blockNumber), timestamp: await timeOf(l.blockNumber) };
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

/** Aave events over a block span, read in windows of LOGS_BLOCK_RANGE. */
async function readRange(f: Filter, from: bigint, to: bigint): Promise<AaveEvent[]> {
  const logs: Log[] = [];
  for (let s = from; s <= to; s += BigInt(RANGE)) {
    const e = s + BigInt(RANGE) - 1n > to ? to : s + BigInt(RANGE) - 1n;
    logs.push(...await logsIn(f, s, e));
  }
  return Promise.all(logs.map(toEvent));
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
