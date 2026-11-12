// Kelp revenue model for the rsETH loops on Aave. Pure functions, used by the site and the report.
//
// Kelp's revenue on a block of rsETH = fee × gross reward rate × ETH backing, accrued daily.
// A  (Kelp stalls):   the loops unwind through Kelp's queue in equal batches, one per ~28-day cycle,
//                     and the ETH leaves Kelp as each batch is redeemed.
// B1 (fast exit):     a bridge loan clears the loops in about a month; the ETH leaves Kelp.
// B2 (migration):     the loops move to an isolated rsETH market on Aave; Kelp keeps the ETH.
// Gap = A − B1: what Kelp gains by stalling instead of a fast exit, and the most we can ask it to give back.

export interface KelpParams {
  rseth: number;          // rsETH in scope
  rsethEth: number;       // ETH per rsETH
  ethUsd: number;
  netYieldPct: number;    // yield to rsETH holders, net of Kelp's fee
  feeBps: number;
  unwindDays: number;     // scenario A length
  cycleDays: number;
  fastExitDays: number;   // scenario B1
  horizonDays: number;
  wethDebt: number;       // ETH borrowed by the loops in scope
}

export interface Cycle { cycle: number; startDay: number; endDay: number; rsethStart: number; redeemed: number; rsethEnd: number; feeEth: number }

export const grossYield = (p: Pick<KelpParams, "netYieldPct" | "feeBps">) => p.netYieldPct / (1 - p.feeBps / 10_000);
/** Kelp's fee a year per ETH of backing. */
export const feeRate = (p: Pick<KelpParams, "netYieldPct" | "feeBps">) => (grossYield(p) / 100) * (p.feeBps / 10_000);

/** rsETH left at day t when equal batches leave at the end of each cycle until the loops are gone. */
export function rsethAt(p: KelpParams, day: number, days = p.unwindDays) {
  // The last, partial batch leaves on the final day rather than at the end of a full cycle.
  if (day >= days) return 0;
  const batch = p.rseth / (days / p.cycleDays);
  return Math.max(0, p.rseth - batch * Math.floor(day / p.cycleDays));
}

/** Cycle-by-cycle schedule for scenario A. */
export function schedule(p: KelpParams, days = p.unwindDays): Cycle[] {
  const out: Cycle[] = [];
  const per = feeRate(p) / 365;
  let left = p.rseth, c = 0;
  while (left > 1e-6 && c < 60) {
    const start = c * p.cycleDays, end = Math.min(start + p.cycleDays, days);
    const end1 = rsethAt(p, end, days);
    const fee = left * p.rsethEth * per * (end - start); // TVL constant within a cycle, redeemed at its end
    out.push({ cycle: c + 1, startDay: start, endDay: end, rsethStart: left, redeemed: left - end1, rsethEnd: end1, feeEth: fee });
    left = end1; c++;
  }
  return out;
}

/** Kelp's fee over the horizon, in ETH, for each scenario. */
export function scenarios(p: KelpParams) {
  const per = feeRate(p) / 365;
  const tvl = p.rseth * p.rsethEth;
  const H = p.horizonDays;
  let a = 0;
  for (let d = 0; d < H; d++) a += rsethAt(p, d) * p.rsethEth * per;
  // B1: straight-line exit over fastExitDays.
  const fd = Math.min(p.fastExitDays, H);
  const b1 = tvl * per * fd * 0.5;
  const b2 = tvl * per * H;
  return { A: a, B1: b1, B2: b2, gap: a - b1, migrationGain: b2 - a, annualFullTvl: tvl * per * 365 };
}

/** Borrow-rate cut in the isolated market if a budget (ETH over the horizon) is paid to borrowers. */
export function rateCutPct(budgetEth: number, p: Pick<KelpParams, "wethDebt" | "horizonDays">) {
  return (budgetEth / p.wethDebt) * (365 / p.horizonDays) * 100;
}

/** Aave V3 kinked rate: borrow APR at utilization u (%). */
export function borrowAt(u: number, irm: { optimal: number; base: number; slope1: number; slope2: number }) {
  return u <= irm.optimal ? irm.base + (u / irm.optimal) * irm.slope1 : irm.base + irm.slope1 + ((u - irm.optimal) / (100 - irm.optimal)) * irm.slope2;
}

/** Borrow rate an isolated market must charge so WETH lenders earn `supplierPct`. */
export function isolatedBorrow(supplierPct: number, utilization: number, reserveFactor: number) {
  return supplierPct / ((utilization / 100) * (1 - reserveFactor / 100));
}

/** Return on equity of a loop at leverage L. */
export const roe = (L: number, yieldPct: number, borrowPct: number) => L * yieldPct - (L - 1) * borrowPct;
