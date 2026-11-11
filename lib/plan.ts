// The Offboarding tab: progress against the plan's 2 November baseline, whether the loops
// still pay, and every parameter change made on-chain. All of it is read from the chain;
// only the plan's own figures come from config/plan.ts.

import { decodeAbiParameters, formatUnits, parseAbi, toEventSelector } from "viem";
import { AAVE_V3_CORE, type Address, type LoopAsset } from "@/config/assets";
import { ASSET_PLANS, PLAN, type AssetPlan } from "@/config/plan";
import { cached } from "./cache";
import { client, resolveReserve, type Reserve } from "./chain";
import { blockTime, logsSplit, padTopic } from "./events";
import { getLoops } from "./loops";
import { hget, hset, storageKind } from "./store";
import type { PlanResponse, PlanDay, PlanChange } from "./types";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const poolAbi = parseAbi([
  "struct ReserveConfigurationMap { uint256 data; }",
  "struct ReserveData { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }",
  "function getReserveData(address asset) view returns (ReserveData)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const DAY = 86_400;
const BLOCK_SECONDS = 12;
const RAY = 1e27;
const YEAR = 365 * DAY;

// ── small storage helpers (Upstash when connected, memory otherwise) ──────────
const memory = new Map<string, string>();
async function load<T>(field: string): Promise<T | null> {
  if (storageKind() !== "none") { try { const v = await hget("plan", field); if (v) return (typeof v === "string" ? JSON.parse(v) : v) as T; } catch { /* fall through */ } }
  const m = memory.get(field);
  return m ? (JSON.parse(m) as T) : null;
}
async function save(field: string, value: unknown) {
  const s = JSON.stringify(value);
  memory.set(field, s);
  if (storageKind() !== "none") await hset("plan", field, s).catch(() => {});
}

// ── daily history ─────────────────────────────────────────────────────────────

/** Days of history kept for the chart and the offboarding calendar. */
const HISTORY_DAYS = 90;
const BACKFILL_PER_CALL = 24;
const historyErrors = new Map<string, string>();
const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** One reading per day at 00:00 UTC: the asset's supply on Aave and the tracked holders' debt. */
async function history(r: Reserve, holders: Address[], plan: AssetPlan): Promise<PlanDay[]> {
  const c = client();
  const head = await c.getBlock();
  const nowS = Number(head.timestamp);
  const first = Math.min(Date.parse(`${plan.baseline.date}T00:00:00Z`) / 1000 - 7 * DAY, Math.floor(nowS / DAY) * DAY - HISTORY_DAYS * DAY);
  const days: number[] = [];
  for (let t = first; t < Math.floor(nowS / DAY) * DAY + 1; t += DAY) days.push(t);

  const key = `history:v2:${r.symbol}`;
  const saved = (await load<Record<string, PlanDay>>(key)) ?? {};
  const out: PlanDay[] = [];
  let changed = false;
  const failed: string[] = [];
  const dec = Number(await c.readContract({ address: r.aToken, abi: erc20, functionName: "decimals" }));
  const readDay = async (t: number): Promise<PlanDay | null> => {
    const date = isoDay(t);
    const block = BigInt(Number(head.number) - Math.round((nowS - t) / BLOCK_SECONDS));
    try {
      const [supply, price, debtPrice, ...rows] = await Promise.all([
        c.readContract({ address: r.aToken, abi: erc20, functionName: "totalSupply", blockNumber: block }),
        c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.underlying], blockNumber: block }),
        c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.debtUnderlying], blockNumber: block }),
        ...holders.map((h) => Promise.all([
          c.readContract({ address: r.aToken, abi: erc20, functionName: "balanceOf", args: [h], blockNumber: block }),
          c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getUserAccountData", args: [h], blockNumber: block }),
        ])),
      ]);
      const px = Number(formatUnits(price, 8)), dpx = Number(formatUnits(debtPrice, 8));
      // Same attribution as today's positions: the wallet's debt, pro rata to this asset's share of its collateral.
      const debtUsd = rows.reduce((s, [bal, acct]) => {
        const coll = Number(formatUnits(acct[0], 8)), debt = Number(formatUnits(acct[1], 8));
        const mine = Number(formatUnits(bal, dec)) * px;
        return s + (coll > 0 ? debt * Math.min(1, mine / coll) : 0);
      }, 0);
      return { date, block: Number(block), supplied: Number(formatUnits(supply, dec)), debt: dpx ? debtUsd / dpx : 0, debtUsd, rate: Number(price) / Number(debtPrice) };
    } catch (e) { failed.push(`${date}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)}`); return null; /* the RPC may not serve old state (no archive): skip the day */ }
  };
  // Newest first, and at most BACKFILL_PER_CALL days per request: a cold start fills the
  // calendar over a few visits instead of timing out.
  const missing = days.filter((t) => !saved[isoDay(t)]).reverse().slice(0, BACKFILL_PER_CALL);
  for (let i = 0; i < missing.length; i += 6) {
    for (const day of await Promise.all(missing.slice(i, i + 6).map(readDay))) if (day) { saved[day.date] = day; changed = true; }
  }
  for (const t of days) if (saved[isoDay(t)]) out.push(saved[isoDay(t)]);
  if (changed) await save(key, saved);
  if (failed.length) historyErrors.set(r.symbol, `${failed.length} past days could not be read (${failed[0]})`); else historyErrors.delete(r.symbol);
  return out;
}

// ── carry ─────────────────────────────────────────────────────────────────────

const apy = (aprRay: bigint) => (Math.pow(1 + Number(aprRay) / RAY / YEAR, YEAR) - 1) * 100;
const annualise = (ratio: number, days: number) => (Math.pow(ratio, 365 / days) - 1) * 100;
const bits = (d: bigint, from: number, to: number) => Number((d >> BigInt(from)) & ((1n << BigInt(to - from + 1)) - 1n));

async function carry(r: Reserve, days30: PlanDay[]) {
  const c = client();
  const head = await c.getBlockNumber();
  const then = head - BigInt(Math.round((30 * DAY) / BLOCK_SECONDS));
  const [now, past] = await Promise.all([
    c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getReserveData", args: [r.debtUnderlying] }),
    c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getReserveData", args: [r.debtUnderlying], blockNumber: then }).catch(() => null),
  ]);
  const [pNow, dNow, pThen, dThen] = await Promise.all([
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.underlying] }),
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.debtUnderlying] }),
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.underlying], blockNumber: then }).catch(() => null),
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.debtUnderlying], blockNumber: then }).catch(() => null),
  ]);
  const rateNow = Number(pNow) / Number(dNow);
  const ratePast = pThen && dThen ? Number(pThen) / Number(dThen) : days30[0]?.rate ?? null;
  return {
    yieldPct: ratePast ? annualise(rateNow / ratePast, 30) : null,
    borrowPct: apy(now.currentVariableBorrowRate),
    borrowAvg30Pct: past ? annualise(Number(now.variableBorrowIndex) / Number(past.variableBorrowIndex), 30) : null,
    reserveFactorPct: bits(now.configuration.data, 64, 79) / 100,
    exchangeRate: rateNow,
  };
}

// ── parameter changes ─────────────────────────────────────────────────────────

type Decoder = { sig: string; data: string[]; describe: (asset: string, v: any[], topics: string[]) => string };
const pct = (bps: bigint | number) => `${(Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const DECODERS: Decoder[] = [
  { sig: "ReserveFrozen(address,bool)", data: ["bool"], describe: (a, [f]) => (f ? `${a} frozen` : `${a} unfrozen`) },
  { sig: "ReservePaused(address,bool)", data: ["bool"], describe: (a, [p]) => (p ? `${a} paused` : `${a} unpaused`) },
  { sig: "ReserveBorrowing(address,bool)", data: ["bool"], describe: (a, [b]) => `${a} borrowing ${b ? "enabled" : "disabled"}` },
  { sig: "CollateralConfigurationChanged(address,uint256,uint256,uint256)", data: ["uint256", "uint256", "uint256"], describe: (a, [ltv, lt, bonus]) => `${a} LTV ${pct(ltv)}, LT ${pct(lt)}, liquidation bonus ${pct(Number(bonus) - 10000)}` },
  { sig: "ReserveFactorChanged(address,uint256,uint256)", data: ["uint256", "uint256"], describe: (a, [o, n]) => `${a} reserve factor ${pct(o)} → ${pct(n)}` },
  { sig: "SupplyCapChanged(address,uint256,uint256)", data: ["uint256", "uint256"], describe: (a, [o, n]) => `${a} supply cap ${Number(o).toLocaleString("en-US")} → ${Number(n).toLocaleString("en-US")}` },
  { sig: "BorrowCapChanged(address,uint256,uint256)", data: ["uint256", "uint256"], describe: (a, [o, n]) => `${a} borrow cap ${Number(o).toLocaleString("en-US")} → ${Number(n).toLocaleString("en-US")}` },
  { sig: "ReserveInterestRateStrategyChanged(address,address,address)", data: ["address", "address"], describe: (a) => `${a} rate strategy replaced` },
  { sig: "ReserveInterestRateDataChanged(address,address,bytes)", data: ["bytes"], describe: (a, [raw]) => {
    try {
      const [o, base, s1, s2] = decodeAbiParameters([{ type: "uint16" }, { type: "uint32" }, { type: "uint32" }, { type: "uint32" }], raw);
      return `${a} rate curve: base ${pct(base)}, slope 1 ${pct(s1)}, slope 2 ${pct(s2)}, kink at ${pct(o)} usage`;
    } catch { return `${a} rate curve changed`; }
  } },
  { sig: "AssetCollateralInEModeChanged(address,uint8,bool)", data: ["uint8", "bool"], describe: (a, [cat, on]) => `${a} ${on ? "added as" : "removed as"} collateral in E-Mode ${cat}` },
  { sig: "AssetLtvzeroInEModeChanged(address,uint8,bool)", data: ["uint8", "bool"], describe: (a, [cat, on]) => `${a} LTV ${on ? "set to 0" : "restored"} in E-Mode ${cat}` },
  { sig: "EModeCategoryAdded(uint8,uint256,uint256,uint256,address,string)", data: ["uint256", "uint256", "uint256", "address", "string"], describe: (_a, [ltv, lt, bonus, , label], topics) => `E-Mode ${Number(BigInt(topics[1]))} (${label}): LTV ${pct(ltv)}, LT ${pct(lt)}, bonus ${pct(Number(bonus) - 10000)}` },
];
const BY_TOPIC = new Map(DECODERS.map((d) => [toEventSelector(`event ${d.sig}`), d]));
const ASSET_TOPICS = DECODERS.filter((d) => !d.sig.startsWith("EModeCategoryAdded")).map((d) => toEventSelector(`event ${d.sig}`));
const EMODE_TOPIC = toEventSelector("event EModeCategoryAdded(uint8,uint256,uint256,uint256,address,string)");

async function changes(r: Reserve, plan: AssetPlan): Promise<PlanChange[]> {
  const head = await client().getBlockNumber();
  const key = `changes:v2:${r.symbol}`;
  const saved = (await load<{ lastBlock: number; items: PlanChange[] }>(key)) ?? { lastBlock: PLAN.timelineFromBlock - 1, items: [] };
  const from = BigInt(saved.lastBlock + 1);
  if (from > head) return saved.items;
  const names = new Map([[r.underlying.toLowerCase(), r.symbol], [r.debtUnderlying.toLowerCase(), r.debtSymbol], ...plan.swapInto.map((s) => [s.address.toLowerCase(), s.symbol] as [string, string])]);
  const [assetLogs, emodeLogs] = await Promise.all([
    logsSplit(PLAN.configurator, [ASSET_TOPICS, [r.underlying, r.debtUnderlying, ...plan.swapInto.map((s) => s.address)].map(padTopic)], from, head),
    plan.eModes.length ? logsSplit(PLAN.configurator, [EMODE_TOPIC, plan.eModes.map((n) => padTopic(`0x${n.toString(16)}`))], from, head) : Promise.resolve([]),
  ]);
  const fresh: PlanChange[] = [];
  for (const l of [...assetLogs, ...emodeLogs]) {
    const d = BY_TOPIC.get(l.topics[0]);
    if (!d) continue;
    const isEmode = d.sig.startsWith("EModeCategoryAdded");
    const asset = isEmode ? "" : names.get(`0x${String(l.topics[1]).slice(26)}`) ?? "Reserve";
    // data holds only the non-indexed values; an indexed strategy address sits in topic 2
    let values: any[] = [];
    try {
      const types = d.sig.startsWith("ReserveInterestRateDataChanged") && l.topics.length < 3 ? ["address", "bytes"] : d.data;
      values = decodeAbiParameters(types.map((t) => ({ type: t })), l.data) as any[];
      if (types.length === 2 && types[1] === "bytes" && d.data.length === 1) values = [values[1]];
    } catch { continue; }
    fresh.push({
      block: Number(l.blockNumber), timestamp: await blockTime(BigInt(l.blockNumber)), txHash: l.transactionHash,
      asset: isEmode ? `E-Mode` : asset, kind: d.sig.split("(")[0], text: d.describe(asset, values, l.topics),
      values: values.map((v) => (typeof v === "bigint" ? v.toString() : v)),
    });
  }
  const items = [...saved.items, ...fresh].sort((a, b) => b.block - a.block);
  await save(key, { lastBlock: Number(head), items });
  return items;
}

// ── collateral swapped within the E-Mode ──────────────────────────────────────

/** wstETH, weETH and cbETH supplied by each loop wallet, in USD: what has moved within the E-Mode. */
async function swapped(plan: AssetPlan, wallets: Address[]): Promise<Map<string, number>> {
  const c = client();
  const out = new Map<string, number>();
  if (!wallets.length || !plan.swapInto.length) return out;
  const reserves = await Promise.all(plan.swapInto.map(async (s) => {
    const [d, price] = await Promise.all([
      c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getReserveData", args: [s.address] }),
      c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [s.address] }),
    ]);
    return { aToken: d.aTokenAddress as Address, price: Number(formatUnits(price, 8)) };
  }));
  await Promise.all(wallets.map(async (w) => {
    const bals = await Promise.all(reserves.map((x) => c.readContract({ address: x.aToken, abi: erc20, functionName: "balanceOf", args: [w] })));
    out.set(w.toLowerCase(), bals.reduce((s, b, i) => s + Number(formatUnits(b, 18)) * reserves[i].price, 0));
  }));
  return out;
}

// ── the tab ───────────────────────────────────────────────────────────────────

export function getPlan(asset: LoopAsset, fresh = false): Promise<PlanResponse | null> {
  const plan = ASSET_PLANS[asset.symbol];
  if (!plan) return Promise.resolve(null);
  return cached(`plan:${asset.symbol}`, async () => {
    const [r, loops] = await Promise.all([resolveReserve(asset), getLoops(asset, fresh)]);
    const holders = loops.positions.filter((p) => p.loops).map((p) => p.address);
    const notes: string[] = [];
    const days = await history(r, holders, plan).catch((e) => { notes.push(`History unavailable: ${e instanceof Error ? e.message : "failed"}`); return [] as PlanDay[]; });
    const [carryNow, changeList, moved] = await Promise.all([
      plan.path === "rate" ? carry(r, days.slice(-31)).catch((e) => { notes.push(`Carry unavailable: ${e instanceof Error ? e.message : "failed"}`); return null; }) : Promise.resolve(null),
      changes(r, plan).catch((e) => { notes.push(`Parameter history unavailable: ${e instanceof Error ? e.message : "failed"}`); return [] as PlanChange[]; }),
      swapped(plan, holders).catch(() => new Map<string, number>()),
    ]);

    const loopers = loops.positions.filter((p) => p.loops);
    const debtNow = loopers.reduce((s, p) => s + p.debt, 0);
    const debtUsdNow = loopers.reduce((s, p) => s + p.debtUsd, 0);
    const base = days.find((d) => d.date === plan.baseline.date) ?? null;
    if (!days.length) notes.push("Daily history needs an RPC that serves past state (Alchemy does).");
    if (historyErrors.has(r.symbol)) notes.push(historyErrors.get(r.symbol)!);

    const y = carryNow?.yieldPct ?? null, b = carryNow?.borrowPct ?? null;
    const roe = (L: number, extraBps: number) => (y == null || b == null ? null : L * y - (L - 1) * (b + extraBps / 100));
    const breakeven = (L: number) => (y == null || b == null || L <= 1 ? null : Math.round(((L * y - (L - 1) * b) / (L - 1)) * 100));
    const coll = loopers.reduce((s, p) => s + p.totalCollateralUsd, 0), eq = loopers.reduce((s, p) => s + p.totalCollateralUsd - p.totalDebtUsd, 0);
    const avgLev = eq > 0 ? coll / eq : null;

    // Step status, from the parameter changes
    const frozen = changeList.find((c) => c.kind === "ReserveFrozen" && c.asset === r.symbol && c.values[0] === true);
    const steps = plan.steps.map((s) => {
      let doneAt: string | null = null, txHash: string | null = null, detail: string | null = null;
      const d = s.detect;
      if (d?.kind === "frozen") {
        if (frozen) { doneAt = frozen.timestamp; txHash = frozen.txHash; } else if (loops.market.frozen) doneAt = "before tracking";
      }
      if (d?.kind === "emodeCollateralAdded") {
        const hits = changeList.filter((c) => c.kind === "AssetCollateralInEModeChanged" && d.assets.includes(c.asset) && Number(c.values[0]) === d.category && c.values[1] === true);
        const added = [...new Set(hits.map((h) => h.asset))];
        if (added.length === d.assets.length) { const last = hits[0]; doneAt = last.timestamp; txHash = last.txHash; }
        else if (added.length) detail = `${added.join(", ")} added so far`;
      }
      if (d?.kind === "reserveFactorAtLeast") {
        const hit = changeList.find((c) => c.kind === "ReserveFactorChanged" && c.asset === r.symbol && Number(c.values[1]) >= d.pct * 100);
        if (hit) { doneAt = hit.timestamp; txHash = hit.txHash; detail = hit.text; }
      }
      if (d?.kind === "ltCut" && plan.ltBaselinePct) {
        const hit = changeList.find((c) => c.kind === "CollateralConfigurationChanged" && c.asset === r.symbol && Number(c.values[1]) > 0 && Number(c.values[1]) < plan.ltBaselinePct! * 100);
        if (hit) { doneAt = hit.timestamp; txHash = hit.txHash; detail = hit.text; }
        else if (loops.market.liquidationThresholdPct > 0 && loops.market.liquidationThresholdPct < plan.ltBaselinePct) { doneAt = "before tracking"; detail = `LT now ${loops.market.liquidationThresholdPct}%`; }
      }
      if (d?.kind === "debtRateChange") {
        const hit = changeList.find((c) => c.asset === r.debtSymbol && (c.kind === "ReserveInterestRateDataChanged" || c.kind === "ReserveInterestRateStrategyChanged" || c.kind === "ReserveFactorChanged"));
        if (hit) { doneAt = hit.timestamp; txHash = hit.txHash; detail = hit.text; }
      }
      return { stage: s.stage, label: s.label, note: s.note ?? null, detail, doneAt, txHash, tracked: !!d };
    });

    // Is exposure declining? The ARFC applies no further measure while it is.
    const ago = (n: number) => days[Math.max(0, days.length - 1 - n)] ?? null;
    const d7 = ago(7), d30 = ago(30);
    const chg = (from: PlanDay | null) => (from && from.debt > 0 ? (debtNow / from.debt - 1) * 100 : null);
    const change7 = chg(d7), change30 = chg(d30);
    const trend: PlanResponse["trend"] = {
      change7Pct: change7, change30Pct: change30,
      declining: change30 == null ? null : change30 <= -1,
      perWeekTokens: d7 ? (d7.debt - debtNow) : null,
    };

    // LT-cut simulator: HF = Σ collateral × LT / debt, so cutting this asset's LT by d points
    // lowers a wallet's HF by (its collateral in this asset × d) / its debt. Positions held constant.
    let ltSim: PlanResponse["ltSim"] = null;
    if (plan.path === "lt") {
      const lt = loops.market.liquidationThresholdPct;
      const borrowers = loops.positions.filter((p) => p.totalDebtUsd > 0 && p.healthFactor != null);
      const remaining = loops.positions.reduce((s, p) => s + p.suppliedUsd, 0);
      const cuts = Array.from({ length: 25 }, (_, i) => i + 1).map((d) => {
        const hit = borrowers.filter((p) => p.healthFactor! >= 1 && p.healthFactor! - (p.suppliedUsd * d) / 100 / p.totalDebtUsd < 1);
        const usd = hit.reduce((s, p) => s + p.suppliedUsd, 0);
        return { points: d, ltAfterPct: lt - d, liquidatableUsd: usd, positions: hit.length, sharePct: remaining ? (usd / remaining) * 100 : 0 };
      });
      const next = cuts[1];
      const coveragePct = loops.market.suppliedTokens ? (loops.positions.reduce((s, p) => s + p.supplied, 0) / loops.market.suppliedTokens) * 100 : null;
      ltSim = {
        ltPct: lt, baselineLtPct: plan.ltBaselinePct ?? null, cuts, coveragePct, trackedCollateralUsd: remaining, borrowers: borrowers.length,
        nextStep: { points: 2, liquidatableUsd: next.liquidatableUsd, sharePct: next.sharePct, under2M: next.liquidatableUsd < 2e6, under5Pct: next.sharePct < 5 },
        maxSafePoints: cuts.filter((c) => c.liquidatableUsd < 2e6 && c.sharePct < 5).reduce((m, c) => (c.points === m + 1 ? c.points : m), 0),
      };
    }

    const movedUsd = [...moved.values()].reduce((s, v) => s + v, 0);
    const rsethCollUsd = loopers.reduce((s, p) => s + p.suppliedUsd, 0);

    const res: PlanResponse = {
      symbol: asset.symbol, debtSymbol: r.debtSymbol, title: PLAN.title, source: PLAN.source,
      url: PLAN.url, resolution: plan.resolution, path: plan.path, pathLabel: plan.pathLabel, ltSim, notes: [...plan.notes], warnings: notes,
      baseline: { ...plan.baseline, debtTokens: base?.debt ?? null, supplied: base?.supplied ?? null, block: base?.block ?? null },
      now: {
        debt: debtNow, debtUsd: debtUsdNow, supplied: loops.market.suppliedTokens, collateralUsd: loops.market.suppliedUsd, positions: loopers.length, asOf: loops.asOf,
        top3DebtPct: debtUsdNow > 0 ? ([...loopers].sort((x, y) => y.debtUsd - x.debtUsd).slice(0, 3).reduce((s, p) => s + p.debtUsd, 0) / debtUsdNow) * 100 : null,
      },
      history: days,
      steps, trend,
      swap: { into: plan.swapInto.map((s) => s.symbol), movedUsd, rsethCollUsd, sharePct: movedUsd + rsethCollUsd > 0 ? (movedUsd / (movedUsd + rsethCollUsd)) * 100 : null },
      carry: carryNow ? {
        ...carryNow,
        avgLeverage: avgLev, roe: PLAN.rateSteps.map((bps) => ({ bps, pct: avgLev ? roe(avgLev, bps) : null })), breakevenBps: avgLev ? breakeven(avgLev) : null,
        positions: loopers.map((p) => ({
          address: p.address, rank: p.rank, label: p.tag?.label ?? null, leverage: p.leverage, debtUsd: p.debtUsd, movedUsd: moved.get(p.address.toLowerCase()) ?? 0, rsethUsd: p.suppliedUsd,
          roe: PLAN.rateSteps.map((bps) => ({ bps, pct: p.leverage ? roe(p.leverage, bps) : null })), breakevenBps: p.leverage ? breakeven(p.leverage) : null,
        })),
      } : null,
      changes: changeList,
    };
    return res;
  }, fresh);
}
