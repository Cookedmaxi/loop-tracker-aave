// Puts the indexer and the RPC together into what the pages show.

import { AAVE_V3_CORE, ASSETS, HF_ALERT, MAX_HOLDERS_SCANNED, MIN_DEBT_USD, TOP_HOLDERS, type Address, type LoopAsset } from "@/config/assets";
import { cached } from "./cache";
import { getAddressTransfers, getHolderCount, getTokenTransfers, getTopHolders, isZero, type Holder, type RawTransfer } from "./blockscout";
import { readPositions, resolveReserve, tokenDecimals, type Reserve } from "./chain";
import { readAaveMarket } from "./aave";
import { hasTokenLogicKey, liquidations, type LiquidationRow } from "./tokenlogic";
import { readPoolEvents, type AaveEvent } from "./events";
import { tagOf } from "./tags";
import type { LoopsResponse, Market, Position, Tx } from "./types";

export function findAsset(symbol: string | null): LoopAsset | undefined {
  return ASSETS.find((a) => a.symbol.toLowerCase() === (symbol ?? "").toLowerCase());
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const holderCache = new Map<string, { at: number; value: Promise<{ list: Holder[]; capped: boolean }> }>();
function holderList(asset: LoopAsset, reserve: Reserve, priceUsd: number) {
  const hit = holderCache.get(asset.symbol);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const cap = asset.maxHolders ?? MAX_HOLDERS_SCANNED;
  const value = (async () => {
    const decimals = await tokenDecimals(reserve.aToken);
    const list = await getTopHolders(reserve.aToken, cap, priceUsd > 0 ? MIN_DEBT_USD / priceUsd : 0, decimals, TOP_HOLDERS);
    return { list, capped: list.length >= cap };
  })().catch((e) => { holderCache.delete(asset.symbol); throw e; });
  holderCache.set(asset.symbol, { at: Date.now(), value });
  return value;
}

export function getLoops(asset: LoopAsset, fresh = false): Promise<LoopsResponse> {
  return cached(`loops:${asset.symbol}`, async () => {
    const reserve = await resolveReserve(asset);
    const [holderCount, m] = await Promise.all([getHolderCount(reserve.aToken).catch(() => null), readAaveMarket(reserve)]);
    // A wallet backs at most its collateral value in debt, so holders below MIN_DEBT_USD of this
    // asset cannot qualify: scanning stops there. The holder list is reused for 10 minutes.
    const scanned = await holderList(asset, reserve, m.priceUsd);
    const holders = scanned.list;
    const [chain, liqs] = await Promise.all([
      readPositions(reserve, holders.map((h) => h.address)),
      // Liquidations of the last 90 days on the market, from the TokenLogic API (key needed).
      hasTokenLogicKey() ? liquidations(AAVE_V3_CORE.marketKey, new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)).catch(() => []) : Promise.resolve([]),
    ]);
    const rate = m.debtPriceUsd ? m.priceUsd / m.debtPriceUsd : 0;

    const all: Position[] = chain.map((p, i) => {
      const equity = p.totalCollateralUsd - p.totalDebtUsd;
      const hf = p.healthFactor;
      // Debt backed by this collateral: the wallet's debt, pro rata to this asset's share of its
      // collateral (the ARFC's method). For a single-collateral loop it equals the whole debt.
      const suppliedUsd = p.supplied * m.priceUsd;
      const share = p.totalCollateralUsd > 0 ? Math.min(1, suppliedUsd / p.totalCollateralUsd) : 0;
      const debtUsd = p.totalDebtUsd * share;
      return {
        rank: i + 1,
        address: p.address,
        tag: tagOf(p.address),
        contractName: holders[i].name,
        ens: holders[i].ens,
        isContract: holders[i].isContract,
        supplied: p.supplied,
        suppliedUsd,
        sharePct: m.suppliedTokens ? (p.supplied / m.suppliedTokens) * 100 : 0,
        debt: m.debtPriceUsd ? debtUsd / m.debtPriceUsd : 0,
        debtUsd,
        loops: debtUsd > 100,
        totalCollateralUsd: p.totalCollateralUsd,
        totalDebtUsd: p.totalDebtUsd,
        healthFactor: hf,
        leverage: equity > 0 && p.totalDebtUsd > 0 ? p.totalCollateralUsd / equity : null,
        dropToLiquidationPct: hf && hf > 1 ? (1 - 1 / hf) * 100 : null,
        alert: hf !== null && hf < HF_ALERT,
        liquidations: liqs.filter((l) => l.user_liquidated?.toLowerCase() === p.address.toLowerCase()).map((l) => ({
          timestamp: l.timestamp, txHash: l.tx_hash, collateralSymbol: l.collateral_symbol, collateralAmount: Number(l.collateral_amount),
          debtSymbol: l.debt_symbol, debtAmount: Number(l.debt_amount), debtUsd: Number(l.debt_usd),
        })),
      };
    });

    // Every position backing at least MIN_DEBT_USD, plus the largest holders even without debt.
    const positions = all.filter((p, i) => p.debtUsd >= MIN_DEBT_USD || i < TOP_HOLDERS).map((p, i) => ({ ...p, rank: i + 1 }));

    const trackedSupplied = sum(positions.map((p) => p.supplied));
    const trackedDebt = sum(positions.map((p) => p.debt));
    const collateralInDebtAsset = trackedSupplied * rate;
    const share = (n: number) => sum(positions.slice(0, n).map((p) => p.sharePct));
    const market: Market = {
      symbol: reserve.symbol, debtSymbol: reserve.debtSymbol, venue: AAVE_V3_CORE.name,
      aToken: reserve.aToken, variableDebtToken: reserve.variableDebtToken,
      suppliedTokens: m.suppliedTokens, suppliedInDebtAsset: m.suppliedTokens * rate, suppliedUsd: m.suppliedTokens * m.priceUsd,
      priceUsd: m.priceUsd, debtPriceUsd: m.debtPriceUsd, rate, holders: holderCount,
      ltvPct: m.ltvPct, liquidationThresholdPct: m.liquidationThresholdPct, frozen: m.frozen, paused: m.paused, active: m.active,
      supplyCap: m.supplyCap, borrowCap: m.borrowCap,
      tracked: positions.length, looping: positions.filter((p) => p.loops).length,
      trackedSupplied, trackedSharePct: m.suppliedTokens ? (trackedSupplied / m.suppliedTokens) * 100 : 0,
      trackedDebt, trackedDebtUsd: sum(positions.map((p) => p.debtUsd)),
      debtToCollateralPct: collateralInDebtAsset ? (trackedDebt / collateralInDebtAsset) * 100 : null,
      netEquityInDebtAsset: collateralInDebtAsset ? collateralInDebtAsset - trackedDebt : null,
      underAlert: positions.filter((p) => p.alert).length,
      top1SharePct: share(1), top3SharePct: share(3), top10SharePct: share(10),
      source: m.source, supplyApy: m.supplyApy, debtBorrowApy: m.debtBorrowApy, utilization: m.utilization, borrowedTokens: m.borrowedTokens,
      dataAsOf: m.dataAsOf, notes: m.notes, liquidations90d: liqs.length,
      scan: { scanned: holders.length, minDebtUsd: MIN_DEBT_USD, capped: scanned.capped, withDebt: positions.filter((p) => p.debtUsd >= MIN_DEBT_USD).length },
    };
    return { asset: asset.symbol, asOf: new Date().toISOString(), market, positions };
  }, fresh);
}

// ── transactions ────────────────────────────────────────────────────────────

function classify(t: RawTransfer, r: Reserve, wallet: Address): string {
  const token = t.tokenAddress.toLowerCase();
  const out = t.from?.toLowerCase() === wallet.toLowerCase();
  if (token === r.aToken.toLowerCase()) return isZero(t.from) ? "Supply" : isZero(t.to) ? "Withdraw" : "Transfer";
  if (token === r.variableDebtToken.toLowerCase()) return isZero(t.from) ? "Borrow" : isZero(t.to) ? "Repay" : "Transfer";
  return out ? "Send" : "Receive";
}

function toTx(t: RawTransfer, r: Reserve, wallet: Address, ranks: Map<string, number>): Tx {
  const other = t.from?.toLowerCase() === wallet.toLowerCase() ? t.to : t.from;
  const counterparty = isZero(other) ? null : other;
  const token = t.tokenAddress.toLowerCase();
  return {
    id: `${t.txHash}:${t.logIndex}:${wallet.toLowerCase()}`,
    txHash: t.txHash, timestamp: t.timestamp, asset: r.symbol,
    wallet, walletRank: ranks.get(wallet.toLowerCase()) ?? null, walletTag: tagOf(wallet),
    action: classify(t, r, wallet), amount: t.amount, tokenSymbol: t.tokenSymbol, tokenAddress: t.tokenAddress,
    assetRelated: [r.aToken, r.variableDebtToken, r.underlying, r.debtUnderlying].some((a) => a.toLowerCase() === token),
    counterparty, counterpartyTag: tagOf(counterparty), source: "Transfer", detail: null,
  };
}

const newestFirst = (a: Tx, b: Tx) => b.timestamp.localeCompare(a.timestamp);

/** An Aave Pool event as a row of the transaction tables. */
function eventToTx(e: AaveEvent, r: Reserve, ranks: Map<string, number>): Tx {
  return {
    id: `${e.txHash}:${e.logIndex}:${e.wallet.toLowerCase()}`,
    txHash: e.txHash, timestamp: e.timestamp, asset: r.symbol,
    wallet: e.wallet, walletRank: ranks.get(e.wallet.toLowerCase()) ?? null, walletTag: tagOf(e.wallet),
    action: e.action, amount: e.amount, tokenSymbol: e.symbol, tokenAddress: e.reserve, assetRelated: true,
    counterparty: e.counterparty, counterpartyTag: tagOf(e.counterparty), source: "Aave event", detail: e.extra ?? null,
  };
}

/** A liquidation reported by the TokenLogic API, for when the chain read missed it. */
function liquidationToTx(l: LiquidationRow, r: Reserve, ranks: Map<string, number>): Tx {
  const wallet = l.user_liquidated as Address;
  return {
    id: `${l.tx_hash}:tl:${wallet.toLowerCase()}`, txHash: l.tx_hash, timestamp: new Date(l.timestamp).toISOString(), asset: r.symbol,
    wallet, walletRank: ranks.get(wallet.toLowerCase()) ?? null, walletTag: tagOf(wallet),
    action: "Liquidation", amount: Number(l.debt_amount), tokenSymbol: l.debt_symbol, tokenAddress: l.debt_address as Address, assetRelated: true,
    counterparty: l.liquidator as Address, counterpartyTag: tagOf(l.liquidator), source: "TokenLogic",
    detail: `${Number(l.collateral_amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${l.collateral_symbol} seized`,
  };
}

/** Mints and burns of the aToken or debt token are Aave actions, already read as Pool events. */
const isAaveMintOrBurn = (t: RawTransfer, r: Reserve) =>
  [r.aToken, r.variableDebtToken].some((a) => a.toLowerCase() === t.tokenAddress.toLowerCase()) && (isZero(t.from) || isZero(t.to));

/**
 * Aave actions come from the chain (Pool events) and the TokenLogic API (liquidations);
 * every other token movement comes from Blockscout. If the event read fails (an RPC that
 * refuses the block range), Aave actions fall back to the aToken and debt-token transfers.
 */
async function combine(r: Reserve, ranks: Map<string, number>, events: Promise<AaveEvent[]>, transfers: { wallet: Address; raw: RawTransfer[] }[], wallets: Set<string> | null): Promise<Tx[]> {
  const ev = await events.catch(() => null);
  const rows: Tx[] = [];
  if (ev) rows.push(...ev.map((e) => eventToTx(e, r, ranks)));
  // With the events in hand, drop the transfers they already explain: aToken and debt-token
  // mints and burns, and the collateral moving in or out of the aToken in the same transaction.
  const evTx = new Set((ev ?? []).map((e) => e.txHash.toLowerCase()));
  const aToken = r.aToken.toLowerCase();
  const explained = (t: RawTransfer) => isAaveMintOrBurn(t, r) || (evTx.has(t.txHash.toLowerCase()) && [t.from, t.to].some((a) => a.toLowerCase() === aToken));
  for (const { wallet, raw } of transfers) for (const t of raw) if (!ev || !explained(t)) rows.push(toTx(t, r, wallet, ranks));
  if (hasTokenLogicKey()) {
    const seen = new Set(rows.filter((x) => x.action === "Liquidation").map((x) => x.txHash.toLowerCase()));
    const liqs = await liquidations(AAVE_V3_CORE.marketKey, new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)).catch(() => []);
    for (const l of liqs) {
      if (seen.has(l.tx_hash.toLowerCase())) continue;
      if (wallets && !wallets.has(l.user_liquidated.toLowerCase())) continue;
      if (!wallets && l.collateral_address?.toLowerCase() !== r.underlying.toLowerCase()) continue;
      rows.push(liquidationToTx(l, r, ranks));
    }
  }
  return rows.sort(newestFirst);
}

async function context(asset: LoopAsset, fresh: boolean) {
  const [reserve, loops] = await Promise.all([resolveReserve(asset), getLoops(asset, fresh)]);
  const ranks = new Map(loops.positions.map((p) => [p.address.toLowerCase(), p.rank]));
  return { reserve, loops, ranks };
}

/** Every recent Aave action on the market's collateral, plus aToken moves between wallets. */
export function getMarketTx(asset: LoopAsset, fresh = false): Promise<Tx[]> {
  return cached(`tx:market:${asset.symbol}`, async () => {
    const { reserve, ranks } = await context(asset, fresh);
    const events = readPoolEvents(reserve, { collateralOnly: true, lookbackBlocks: 50_400 }); // about 7 days
    const raw = await getTokenTransfers(reserve.aToken, 50).catch(() => [] as RawTransfer[]);
    const moves = raw.map((t) => ({ wallet: (isZero(t.from) ? t.to : t.from) as Address, raw: [t] }));
    return combine(reserve, ranks, events, moves, null);
  }, fresh);
}

/** Recent Aave actions and token transfers of every tracked holder. */
export function getHoldersTx(asset: LoopAsset, fresh = false): Promise<Tx[]> {
  return cached(`tx:holders:${asset.symbol}`, async () => {
    const { reserve, loops, ranks } = await context(asset, fresh);
    // Events and transfers for the 30 positions with the most debt: enough for the feed, light on the RPC.
    const wallets = [...loops.positions].sort((x, y) => y.debtUsd - x.debtUsd).slice(0, 30).map((p) => p.address);
    const events = readPoolEvents(reserve, { wallets });
    const transfers: { wallet: Address; raw: RawTransfer[] }[] = [];
    for (let i = 0; i < wallets.length; i += 4) {
      const batch = await Promise.all(wallets.slice(i, i + 4).map(async (w) => ({ wallet: w, raw: await getAddressTransfers(w, 25).catch(() => [] as RawTransfer[]) })));
      transfers.push(...batch);
    }
    return combine(reserve, ranks, events, transfers, new Set(wallets.map((w) => w.toLowerCase())));
  }, fresh);
}

/** Recent Aave actions and token transfers of one wallet. */
export function getWalletTx(asset: LoopAsset, wallet: Address, fresh = false): Promise<Tx[]> {
  return cached(`tx:wallet:${asset.symbol}:${wallet.toLowerCase()}`, async () => {
    const { reserve, loops, ranks } = await context(asset, false);
    // Positions in the holders feed share its saved history; any other wallet gets its own.
    const top = [...loops.positions].sort((x, y) => y.debtUsd - x.debtUsd).slice(0, 30).map((p) => p.address);
    const w = wallet.toLowerCase();
    const inTop = top.some((t) => t.toLowerCase() === w);
    const events = readPoolEvents(reserve, inTop ? { wallets: top } : { wallets: [wallet], tag: w })
      .then((all) => all.filter((e) => e.wallet.toLowerCase() === w));
    const raw = await getAddressTransfers(wallet, 50).catch(() => [] as RawTransfer[]);
    return combine(reserve, ranks, events, [{ wallet, raw }], new Set([wallet.toLowerCase()]));
  }, fresh);
}
