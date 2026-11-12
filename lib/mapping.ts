// Holder mapping of one collateral asset, in the shape of the team's mapping documents:
// every holder down to dust, what each borrows and against what, the loops in detail,
// notes on the positions that matter, who to contact, and what is still unknown.
// Everything is read on-chain; tags come from data/*.json and the tags added on the site.

import { formatUnits, parseAbi } from "viem";
import { AAVE_V3_CORE, MIN_DEBT_USD, type Address, type LoopAsset } from "@/config/assets";
import { COLLATERAL_RESERVES, DEBT_RESERVES, MAPPING } from "@/config/mapping";
import entities from "@/data/entities.json";
import { getHolderCount, getTopHolders } from "./blockscout";
import { client, readPositions, resolveReserve, tokenDecimals } from "./chain";
import { readAaveMarket } from "./aave";
import { listCommunityTags } from "./community";
import { tagOf } from "./tags";
import type { MappingResponse, MappingHolder } from "./types";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const poolAbi = parseAbi([
  "struct ReserveConfigurationMap { uint256 data; }",
  "struct ReserveData { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }",
  "function getReserveData(address asset) view returns (ReserveData)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const FAMILY: Record<string, "ETH" | "BTC"> = {
  WETH: "ETH", wstETH: "ETH", weETH: "ETH", cbETH: "ETH", rsETH: "ETH", osETH: "ETH", rETH: "ETH", tETH: "ETH",
  WBTC: "BTC", cbBTC: "BTC", LBTC: "BTC", tBTC: "BTC", eBTC: "BTC", "BTC.b": "BTC",
};

interface ReserveInfo { symbol: string; asset: Address; aToken: Address; debtToken: Address; decimals: number; price: number; debtSupply: number }

let reserveCache: { at: number; value: Promise<Map<string, ReserveInfo>> } | null = null;
/** aToken, debt token, decimals and price of every reserve the mapping reads; refreshed every 10 minutes. */
function reserves(): Promise<Map<string, ReserveInfo>> {
  if (reserveCache && Date.now() - reserveCache.at < 10 * 60_000) return reserveCache.value;
  const c = client();
  const list = [...new Map([...DEBT_RESERVES, ...COLLATERAL_RESERVES].map((r) => [r.symbol, r])).values()];
  const value = Promise.all(list.map(async (r): Promise<ReserveInfo | null> => {
    try {
      const [d, price] = await Promise.all([
        c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getReserveData", args: [r.address] }),
        c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.address] }),
      ]);
      if (/^0x0{40}$/i.test(d.aTokenAddress)) return null;
      const decimals = await tokenDecimals(d.aTokenAddress as Address);
      const debtSupply = await c.readContract({ address: d.variableDebtTokenAddress as Address, abi: erc20, functionName: "totalSupply" }).catch(() => 0n);
      return { symbol: r.symbol, asset: r.address, aToken: d.aTokenAddress as Address, debtToken: d.variableDebtTokenAddress as Address, decimals, price: Number(formatUnits(price, 8)), debtSupply: Number(formatUnits(debtSupply, decimals)) };
    } catch { return null; }
  })).then((xs) => new Map(xs.filter((x): x is ReserveInfo => !!x).map((x) => [x.symbol, x])));
  value.catch(() => { reserveCache = null; });
  reserveCache = { at: Date.now(), value };
  return value;
}

const cache = new Map<string, { at: number; value: Promise<MappingResponse> }>();

export function getMapping(asset: LoopAsset, fresh = false): Promise<MappingResponse> {
  const hit = cache.get(asset.symbol);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = build(asset).catch((e) => { cache.delete(asset.symbol); throw e; });
  cache.set(asset.symbol, { at: Date.now(), value });
  return value;
}

async function build(asset: LoopAsset): Promise<MappingResponse> {
  const c = client();
  const r = await resolveReserve(asset);
  const [m, holderCount, res, community] = await Promise.all([
    readAaveMarket(r), getHolderCount(r.aToken).catch(() => null), reserves(), listCommunityTags().catch(() => []),
  ]);
  const decimals = await tokenDecimals(r.aToken);
  const holders = await getTopHolders(r.aToken, MAPPING.maxHolders, m.priceUsd > 0 ? MAPPING.dustUsd / m.priceUsd : 0, decimals);
  const chain = await readPositions(r, holders.map((h) => h.address));
  const fam = FAMILY[asset.symbol];

  // What every borrower owes, by asset, and what else it posts as collateral.
  const debtRes = DEBT_RESERVES.map((d) => res.get(d.symbol)).filter((x): x is ReserveInfo => !!x);
  const collRes = COLLATERAL_RESERVES.map((d) => res.get(d.symbol)).filter((x): x is ReserveInfo => !!x && x.symbol !== asset.symbol);
  const borrowers = chain.filter((p) => p.totalDebtUsd > 0);
  const debts = new Map<string, { symbol: string; amount: number; usd: number }[]>();
  const colls = new Map<string, { symbol: string; amount: number; usd: number }[]>();
  await Promise.all(borrowers.map(async (p) => {
    const [db, cb] = await Promise.all([
      Promise.all(debtRes.map((x) => c.readContract({ address: x.debtToken, abi: erc20, functionName: "balanceOf", args: [p.address] }).catch(() => 0n))),
      Promise.all(collRes.map((x) => c.readContract({ address: x.aToken, abi: erc20, functionName: "balanceOf", args: [p.address] }).catch(() => 0n))),
    ]);
    debts.set(p.address, db.map((b, i) => { const amount = Number(formatUnits(b, debtRes[i].decimals)); return { symbol: debtRes[i].symbol, amount, usd: amount * debtRes[i].price }; }).filter((x) => x.usd >= 0.5).sort((a, b) => b.usd - a.usd));
    colls.set(p.address, cb.map((b, i) => { const amount = Number(formatUnits(b, collRes[i].decimals)); return { symbol: collRes[i].symbol, amount, usd: amount * collRes[i].price }; }).filter((x) => x.usd >= 1).sort((a, b) => b.usd - a.usd));
  }));

  // Spark, for the positions that matter: multi-venue loopers carry more risk than one venue shows.
  const big = chain.filter((p) => p.totalDebtUsd >= MIN_DEBT_USD);
  const spark = new Map<string, { collateralUsd: number; debtUsd: number; healthFactor: number | null }>();
  await Promise.all(big.map(async (p) => {
    try {
      const a = await c.readContract({ address: MAPPING.sparkPool, abi: poolAbi, functionName: "getUserAccountData", args: [p.address] });
      const coll = Number(formatUnits(a[0], 8)), debt = Number(formatUnits(a[1], 8));
      if (coll > 1 || debt > 1) spark.set(p.address, { collateralUsd: coll, debtUsd: debt, healthFactor: debt > 0 ? Number(formatUnits(a[5], 18)) : null });
    } catch { /* not on Spark, or Spark unreachable */ }
  }));

  const communityOf = new Map(community.map((t) => [t.address.toLowerCase(), t]));
  const entityInfo = new Map((entities as any[]).map((e) => [e.entity, e]));
  const totalSupplied = m.suppliedTokens;
  const debtPrice = m.debtPriceUsd || 1;

  const rows: MappingHolder[] = chain.map((p, i) => {
    const h = holders[i];
    const suppliedUsd = p.supplied * m.priceUsd;
    const d = debts.get(p.address) ?? [];
    const top = d[0];
    const share = p.totalCollateralUsd > 0 ? Math.min(1, suppliedUsd / p.totalCollateralUsd) : 0;
    const loops = !!top && FAMILY[top.symbol] && FAMILY[top.symbol] === fam;
    const kind: MappingHolder["kind"] = !d.length ? "Supply only" : loops ? "Loop" : FAMILY[top.symbol] ? "Borrows other assets" : "Borrows stables";
    const tag = tagOf(p.address);
    const ct = communityOf.get(p.address.toLowerCase());
    const equity = p.totalCollateralUsd - p.totalDebtUsd;
    const hf = p.healthFactor;
    const unitsInDebt = top ? (suppliedUsd / (res.get(top.symbol)?.price ?? debtPrice)) : null;
    return {
      rank: i + 1, address: p.address,
      isContract: h.isContract, contractName: h.name, ens: h.ens,
      tag: tag ? `${tag.label}` : ct ? `${ct.entity}${ct.label ? ` · ${ct.label}` : ""} (site tag, ${ct.confidence.toLowerCase()})` : null,
      entity: tag?.entity ?? ct?.entity ?? null,
      supplied: p.supplied, suppliedUsd, sharePct: totalSupplied ? (p.supplied / totalSupplied) * 100 : 0,
      kind, loopsAgainst: loops ? top.symbol : null,
      debts: d, otherCollateral: colls.get(p.address) ?? [],
      totalCollateralUsd: p.totalCollateralUsd, totalDebtUsd: p.totalDebtUsd, debtBackedUsd: p.totalDebtUsd * share,
      healthFactor: hf, ltvPct: p.totalCollateralUsd > 0 ? (p.totalDebtUsd / p.totalCollateralUsd) * 100 : null,
      leverage: equity > 0 && p.totalDebtUsd > 0 ? p.totalCollateralUsd / equity : null,
      netEquityUsd: equity,
      collateralInDebtUnits: top ? suppliedUsd / (res.get(top.symbol)?.price ?? debtPrice) : null,
      debtPerUnit: loops && p.supplied > 0 ? top.amount / p.supplied : null,
      unitsInDebt,
      // How far this asset (against what is borrowed) can fall before the wallet is liquidated.
      dropToLiquidationPct: hf && hf > 1 && share > 0 ? Math.min(100, ((1 - 1 / hf) / share) * 100) : null,
      shareOfDebtPct: top ? (top.amount / (res.get(top.symbol)?.debtSupply || Infinity)) * 100 : null,
      spark: spark.get(p.address) ?? null,
    };
  });

  // Rate-path assets (WETH loops) count loops; stablecoin-debt assets count every borrower.
  const mode: "loop" | "borrow" = asset.debtAssets ? "borrow" : "loop";
  const loopers = rows.filter((x) => (mode === "loop" ? x.kind === "Loop" : x.kind !== "Supply only"));
  // Positions in detail: every wallet backing at least MIN_DEBT_USD, loops and stablecoin borrowers alike.
  const bigLoops = rows.filter((x) => x.debtBackedUsd >= MIN_DEBT_USD && x.kind !== "Supply only").sort((a, b) => b.debtBackedUsd - a.debtBackedUsd);
  const loopSet = new Set(loopers);
  const others = rows.filter((x) => !loopSet.has(x));
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  const loopSupplied = sum(loopers.map((x) => x.supplied));
  const debtByAsset = new Map<string, number>();
  for (const x of rows) for (const d of x.debts) debtByAsset.set(d.symbol, (debtByAsset.get(d.symbol) ?? 0) + d.amount * (x.totalDebtUsd > 0 ? Math.min(1, x.debtBackedUsd / x.totalDebtUsd) : 0));
  const lev = bigLoops.map((x) => x.leverage).filter((v): v is number => v != null);
  const ltv = bigLoops.map((x) => x.ltvPct).filter((v): v is number => v != null);

  // Liquidation ladder: debt backed by positions liquidated after a given fall in the asset
  // (price for borrowers, exchange rate for loops), other collateral held constant.
  const ladder = [1, 2, 5, 10, 15, 20, 30, 50].map((drop) => {
    const hit = bigLoops.filter((x) => x.dropToLiquidationPct != null && x.dropToLiquidationPct <= drop);
    return { dropPct: drop, positions: hit.length, debtUsd: sum(hit.map((x) => x.debtBackedUsd)), collateralUsd: sum(hit.map((x) => x.suppliedUsd)) };
  });
  const hfEdges: [string, number, number][] = [["< 1.05", 0, 1.05], ["1.05–1.10", 1.05, 1.1], ["1.10–1.25", 1.1, 1.25], ["1.25–1.50", 1.25, 1.5], ["1.50–2.00", 1.5, 2], ["≥ 2.00", 2, Infinity]];
  const hfBuckets = hfEdges.map(([label, lo, hi]) => {
    const xs = bigLoops.filter((x) => x.healthFactor != null && x.healthFactor >= lo && x.healthFactor < hi);
    return { label, positions: xs.length, debtUsd: sum(xs.map((x) => x.debtBackedUsd)) };
  });
  const totalBig = sum(bigLoops.map((x) => x.debtBackedUsd));
  const wHf = totalBig ? sum(bigLoops.filter((x) => x.healthFactor).map((x) => x.healthFactor! * x.debtBackedUsd)) / sum(bigLoops.filter((x) => x.healthFactor).map((x) => x.debtBackedUsd)) : null;
  const hhi = totalBig ? sum(bigLoops.map((x) => ((x.debtBackedUsd / totalBig) * 100) ** 2)) : 0;
  const debtTop = (n: number) => (totalBig ? (sum(bigLoops.slice(0, n).map((x) => x.debtBackedUsd)) / totalBig) * 100 : 0);
  const contracts = bigLoops.filter((x) => x.isContract);
  const identified = bigLoops.filter((x) => x.entity && x.entity !== "Unknown whale");
  const analytics = {
    mode, weightedHf: wHf, hhi, debtTop1Pct: debtTop(1), debtTop3Pct: debtTop(3), debtTop10Pct: debtTop(10),
    positionsFor80Pct: (() => { let acc = 0, n = 0; for (const x of bigLoops) { acc += x.debtBackedUsd; n++; if (acc >= totalBig * 0.8) break; } return n; })(),
    contractDebtPct: totalBig ? (sum(contracts.map((x) => x.debtBackedUsd)) / totalBig) * 100 : 0,
    identifiedDebtPct: totalBig ? (sum(identified.map((x) => x.debtBackedUsd)) / totalBig) * 100 : 0,
    sparkDebtUsd: sum(bigLoops.filter((x) => x.spark).map((x) => x.spark!.debtUsd)),
    sparkPositions: bigLoops.filter((x) => x.spark).length,
    ladder, hfBuckets,
  };

  // Notes on the positions that matter
  const notes: { rank: number; text: string }[] = [];
  const byHf = [...bigLoops].filter((x) => x.healthFactor).sort((a, b) => a.healthFactor! - b.healthFactor!);
  for (const x of byHf.slice(0, 2)) notes.push({ rank: x.rank, text: `Closest to liquidation: health factor ${x.healthFactor!.toFixed(3)}; a ${x.dropToLiquidationPct?.toFixed(1)}% fall in ${x.kind === "Loop" ? `the ${asset.symbol}/${x.loopsAgainst} rate` : `the ${asset.symbol} price`} would liquidate it.` });
  for (const x of bigLoops) {
    if (x.kind === "Loop" && x.debtPerUnit != null && x.debtPerUnit > 1) notes.push({ rank: x.rank, text: `Owes ${x.debtPerUnit.toFixed(3)} ${x.loopsAgainst} per ${asset.symbol}: the position holds only because ${asset.symbol} is worth more than 1 ${x.loopsAgainst}.` });
    const extra = x.otherCollateral.filter((o) => o.usd > Math.max(10_000, x.totalCollateralUsd * 0.01));
    if (extra.length) notes.push({ rank: x.rank, text: `Also posts ${extra.map((o) => `${fmtN(o.amount)} ${o.symbol}`).join(", ")} as collateral, which cushions the loop.` });
    if (x.spark) notes.push({ rank: x.rank, text: `Also active on Spark: ${usd(x.spark.collateralUsd)} collateral, ${usd(x.spark.debtUsd)} debt${x.spark.healthFactor ? `, health factor ${x.spark.healthFactor.toFixed(3)}` : ""}. A multi-venue looper.` });
    if (x.shareOfDebtPct != null && x.shareOfDebtPct >= 1) notes.push({ rank: x.rank, text: `Its ${x.debts[0]?.symbol} debt is ${x.shareOfDebtPct.toFixed(1)}% of all variable ${x.debts[0]?.symbol} debt on Aave V3 Core; unwinding it moves ${x.sharePct.toFixed(1)}% of the ${asset.symbol} market.` });
  }
  notes.sort((a, b) => a.rank - b.rank);

  // Who to contact
  const known = new Map<string, { entity: string; ranks: number[]; debtUsd: number; info: any }>();
  for (const x of rows) {
    if (!x.entity || x.entity === "Unknown whale") continue;
    const k = known.get(x.entity) ?? { entity: x.entity, ranks: [], debtUsd: 0, info: entityInfo.get(x.entity) ?? null };
    k.ranks.push(x.rank); k.debtUsd += x.debtBackedUsd; known.set(x.entity, k);
  }
  const unknown = bigLoops.filter((x) => !x.entity || x.entity === "Unknown whale").slice(0, 12);
  const questions = bigLoops.filter((x) => (!x.entity || x.entity === "Unknown whale") && (x.sharePct >= 2 || x.debtBackedUsd >= 5e6)).slice(0, 8)
    .map((x) => `Who controls #${x.rank} (${x.address.slice(0, 6)}…${x.address.slice(-4)}, ${x.isContract ? x.contractName ?? "contract" : "EOA"}), backing ${usd(x.debtBackedUsd)}?`);

  return {
    symbol: asset.symbol, debtSymbol: r.debtSymbol, readAt: new Date().toISOString(),
    priceUsd: m.priceUsd, rate: m.debtPriceUsd ? m.priceUsd / m.debtPriceUsd : null,
    totalSupplied, totalSuppliedUsd: totalSupplied * m.priceUsd, holderCount, listed: rows.length, dustUsd: MAPPING.dustUsd,
    top1Pct: rows[0]?.sharePct ?? 0, top3Pct: sum(rows.slice(0, 3).map((x) => x.sharePct)), top10Pct: sum(rows.slice(0, 10).map((x) => x.sharePct)),
    loopers: loopers.length, bigLoops: bigLoops.length, loopSupplied, loopSharePct: totalSupplied ? (loopSupplied / totalSupplied) * 100 : 0,
    debtBackedUsd: sum(rows.map((x) => x.debtBackedUsd)),
    debtByAsset: [...debtByAsset.entries()].map(([symbol, amount]) => ({ symbol, amount, usd: amount * (res.get(symbol)?.price ?? 1) })).sort((a, b) => b.usd - a.usd),
    leverageRange: lev.length ? [Math.min(...lev), Math.max(...lev)] : null, ltvRange: ltv.length ? [Math.min(...ltv), Math.max(...ltv)] : null,
    othersCount: others.length, othersSupplied: sum(others.map((x) => x.supplied)),
    holders: rows, loops: bigLoops, notes, analytics,
    known: [...known.values()].sort((a, b) => b.debtUsd - a.debtUsd).map((k) => ({ entity: k.entity, ranks: k.ranks, debtUsd: k.debtUsd, approach: k.info?.approach ?? null, status: k.info?.status ?? null, website: k.info?.website || null, x: k.info?.x || null })),
    unknown: unknown.map((x) => ({ rank: x.rank, address: x.address, debtUsd: x.debtBackedUsd, sharePct: x.sharePct })),
    questions,
  };
}

function usd(n: number) { return n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`; }
function fmtN(n: number) { return n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(3); }
