// Puts the indexer and the RPC together into what the pages show.

import { AAVE_V3_CORE, ASSETS, HF_ALERT, TOP_HOLDERS, type Address, type LoopAsset } from "@/config/assets";
import { cached } from "./cache";
import { getAddressTransfers, getHolderCount, getTokenTransfers, getTopHolders, isZero, type RawTransfer } from "./blockscout";
import { resolveReserve, type Reserve } from "./chain";
import { aaveSource } from "./aave";
import { tagOf } from "./tags";
import type { LoopsResponse, Market, Position, Tx } from "./types";

export function findAsset(symbol: string | null): LoopAsset | undefined {
  return ASSETS.find((a) => a.symbol.toLowerCase() === (symbol ?? "").toLowerCase());
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function getLoops(asset: LoopAsset, fresh = false): Promise<LoopsResponse> {
  return cached(`loops:${asset.symbol}`, async () => {
    const reserve = await resolveReserve(asset);
    const [holders, holderCount, m] = await Promise.all([
      getTopHolders(reserve.aToken, TOP_HOLDERS),
      getHolderCount(reserve.aToken).catch(() => null),
      aaveSource().readMarket(reserve),
    ]);
    const chain = await aaveSource().readPositions(reserve, holders.map((h) => h.address));
    const rate = m.debtPriceUsd ? m.priceUsd / m.debtPriceUsd : 0;

    const positions: Position[] = chain.map((p, i) => {
      const equity = p.totalCollateralUsd - p.totalDebtUsd;
      const hf = p.healthFactor;
      return {
        rank: i + 1,
        address: p.address,
        tag: tagOf(p.address),
        contractName: holders[i].name,
        ens: holders[i].ens,
        isContract: holders[i].isContract,
        supplied: p.supplied,
        suppliedUsd: p.supplied * m.priceUsd,
        sharePct: m.suppliedTokens ? (p.supplied / m.suppliedTokens) * 100 : 0,
        debt: p.debt,
        debtUsd: p.debt * m.debtPriceUsd,
        loops: p.debt > 0,
        totalCollateralUsd: p.totalCollateralUsd,
        totalDebtUsd: p.totalDebtUsd,
        healthFactor: hf,
        leverage: equity > 0 && p.totalDebtUsd > 0 ? p.totalCollateralUsd / equity : null,
        dropToLiquidationPct: hf && hf > 1 ? (1 - 1 / hf) * 100 : null,
        alert: hf !== null && hf < HF_ALERT,
      };
    });

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
      trackedDebt, trackedDebtUsd: trackedDebt * m.debtPriceUsd,
      debtToCollateralPct: collateralInDebtAsset ? (trackedDebt / collateralInDebtAsset) * 100 : null,
      netEquityInDebtAsset: collateralInDebtAsset ? collateralInDebtAsset - trackedDebt : null,
      underAlert: positions.filter((p) => p.alert).length,
      top1SharePct: share(1), top3SharePct: share(3), top10SharePct: share(10),
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
    counterparty, counterpartyTag: tagOf(counterparty),
  };
}

const newestFirst = (a: Tx, b: Tx) => b.timestamp.localeCompare(a.timestamp);

async function context(asset: LoopAsset, fresh: boolean) {
  const [reserve, loops] = await Promise.all([resolveReserve(asset), getLoops(asset, fresh)]);
  const ranks = new Map(loops.positions.map((p) => [p.address.toLowerCase(), p.rank]));
  return { reserve, loops, ranks };
}

/** Every recent supply, withdrawal and transfer on the market (moves of the aToken). */
export function getMarketTx(asset: LoopAsset, fresh = false): Promise<Tx[]> {
  return cached(`tx:market:${asset.symbol}`, async () => {
    const { reserve, ranks } = await context(asset, fresh);
    const raw = await getTokenTransfers(reserve.aToken, 50);
    return raw.map((t) => toTx(t, reserve, (isZero(t.from) ? t.to : t.from) as Address, ranks)).sort(newestFirst);
  }, fresh);
}

/** Recent transfers of every tracked holder, on any token. Read a few wallets at a time. */
export function getHoldersTx(asset: LoopAsset, fresh = false): Promise<Tx[]> {
  return cached(`tx:holders:${asset.symbol}`, async () => {
    const { reserve, loops, ranks } = await context(asset, fresh);
    const out: Tx[] = [];
    const wallets = loops.positions.map((p) => p.address);
    for (let i = 0; i < wallets.length; i += 4) {
      const batch = await Promise.all(wallets.slice(i, i + 4).map((w) =>
        getAddressTransfers(w, 25).then((raw) => raw.map((t) => toTx(t, reserve, w, ranks))).catch(() => [] as Tx[])));
      out.push(...batch.flat());
    }
    return out.sort(newestFirst);
  }, fresh);
}

/** Recent transfers of one wallet. */
export function getWalletTx(asset: LoopAsset, wallet: Address, fresh = false): Promise<Tx[]> {
  return cached(`tx:wallet:${asset.symbol}:${wallet.toLowerCase()}`, async () => {
    const { reserve, ranks } = await context(asset, false);
    const raw = await getAddressTransfers(wallet, 50);
    return raw.map((t) => toTx(t, reserve, wallet, ranks)).sort(newestFirst);
  }, fresh);
}
