// Aave actions read from the chain: the Pool's own Supply, Withdraw, Borrow, Repay and
// LiquidationCall events. Unlike token transfers, they give the exact action, the exact
// amount (no accrued interest mixed in), who acted for whom, and the block's time.
//
// RPC providers cap how many blocks one eth_getLogs may span, so the lookback is read in
// windows of LOGS_BLOCK_RANGE blocks (default 10 000; lower it if your provider refuses).

import { formatUnits, parseAbi, parseAbiItem, type Log } from "viem";
import { AAVE_V3_CORE, type Address } from "@/config/assets";
import { client, type Reserve } from "./chain";

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

/** Aave events of the given reserves, optionally only those that change the given wallets. Newest first. */
export async function readPoolEvents(reserves: Reserve, opts: { wallets?: Address[]; lookbackBlocks?: number; collateralOnly?: boolean } = {}): Promise<AaveEvent[]> {
  const c = client();
  const pool = AAVE_V3_CORE.pool;
  const assets = opts.collateralOnly ? [reserves.underlying] : [reserves.underlying, reserves.debtUnderlying];
  const users = opts.wallets?.length ? opts.wallets : undefined;
  const latest = await c.getBlockNumber();
  const start = latest - BigInt(opts.lookbackBlocks ?? LOOKBACK);

  const logs: Log[] = [];
  for (let from = start; from <= latest; from += BigInt(RANGE)) {
    const to = from + BigInt(RANGE) - 1n > latest ? latest : from + BigInt(RANGE) - 1n;
    const window = { address: pool, fromBlock: from, toBlock: to } as const;
    const batch = await Promise.all([
      c.getLogs({ ...window, event: EVENTS.Supply, args: { reserve: assets, onBehalfOf: users } }),
      c.getLogs({ ...window, event: EVENTS.Withdraw, args: { reserve: assets, user: users } }),
      c.getLogs({ ...window, event: EVENTS.Borrow, args: { reserve: assets, onBehalfOf: users } }),
      c.getLogs({ ...window, event: EVENTS.Repay, args: { reserve: assets, user: users } }),
      c.getLogs({ ...window, event: EVENTS.LiquidationCall, args: { collateralAsset: reserves.underlying, user: users } }),
    ]);
    logs.push(...batch.flat());
  }

  const out = await Promise.all(logs.map(async (l: any): Promise<AaveEvent> => {
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
  }));
  return out.sort((x, y) => y.block - x.block || y.logIndex - x.logIndex);
}
