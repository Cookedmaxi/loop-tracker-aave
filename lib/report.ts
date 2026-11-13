// Monthly progress report on the repositioning, in the shape LlamaRisk reports it on the forum:
// a summary across the assets in scope, then one section per asset, then the on-chain changes.
// Built from the same figures as the Offboarding tab.

import { ASSETS, HF_ALERT } from "@/config/assets";
import { ASSET_PLANS, PLAN } from "@/config/plan";
import { getLoops } from "./loops";
import { getPlan } from "./plan";
import type { PlanResponse } from "./types";

const usd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "n/a" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`);
const pct = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? "n/a" : `${n > 0 ? "+" : ""}${n.toFixed(d)}%`);
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function status(p: PlanResponse) {
  const follow = p.steps.find((s) => s.stage.startsWith("Follow-up"));
  if (follow?.doneAt) return "Follow-up control applied";
  if (p.trend.declining) return "Declining, no further measure";
  if (p.trend.declining === false) return "Not declining";
  return "Monitoring";
}

export async function buildReport(only?: string): Promise<{ markdown: string; month: string; generatedAt: string }> {
  const assets = ASSETS.filter((a) => ASSET_PLANS[a.symbol] && (!only || a.symbol === only));
  const plans = (await Promise.all(assets.map((a) => getPlan(a).catch(() => null)))).filter((p): p is PlanResponse => !!p);
  const now = new Date();
  const month = now.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const baseDebt = plans.reduce((s, p) => s + p.baseline.debtUsd, 0);
  const nowDebt = plans.reduce((s, p) => s + p.now.debtUsd, 0);
  const declining = plans.filter((p) => p.trend.declining).length;
  const applied = plans.filter((p) => p.steps.find((s) => s.stage.startsWith("Follow-up"))?.doneAt);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const L: string[] = [];
  L.push(only ? `# ${only} offboarding on Aave V3 Core: report, ${month}` : `# Repositioning Aave V3 Core: progress report, ${month}`, "");
  L.push(`Reporting date: ${day(now.toISOString())}. Baseline: the [ARFC](${PLAN.url}) figures of ${day(plans[0]?.baseline.date ?? "2026-11-09")}. Positions, debt, rates and parameter changes are read on-chain from Aave V3 Ethereum Core.`, "");
  L.push("## Summary", "");
  L.push(`The collateral in scope backs ${usd(nowDebt)} of debt, against ${usd(baseDebt)} at the baseline (${pct(baseDebt ? (nowDebt / baseDebt - 1) * 100 : null)}). Exposure declined over the past 30 days for ${declining} of ${plans.length} assets. ${applied.length ? `Follow-up controls have been applied to ${applied.map((p) => p.symbol).join(", ")}.` : "No follow-up control has been applied."}`, "");
  L.push("| Asset | Resolution | Collateral | Debt backed | Baseline debt | Change | 30 days | Status |");
  L.push("|---|---|---:|---:|---:|---:|---:|---|");
  for (const p of plans) {
    L.push(`| ${p.symbol} | ${p.resolution} | ${usd(p.now.collateralUsd)} | ${usd(p.now.debtUsd)} | ${usd(p.baseline.debtUsd)} | ${pct((p.now.debtUsd / p.baseline.debtUsd - 1) * 100)} | ${pct(p.trend.change30Pct)} | ${status(p)} |`);
  }
  L.push("", "## Per asset", "");
  for (const p of plans) {
    L.push(`### ${p.symbol}`, "");
    const debt = p.path === "rate" ? `${Math.round(p.now.debt).toLocaleString("en-US")} ${p.debtSymbol} (${usd(p.now.debtUsd)})` : `${usd(p.now.debtUsd)} of ${p.debtSymbol.toLowerCase()}`;
    L.push(`- Debt backed: ${debt}, ${pct((p.now.debtUsd / p.baseline.debtUsd - 1) * 100)} against the ${usd(p.baseline.debtUsd)} baseline; ${pct(p.trend.change7Pct, 2)} over 7 days and ${pct(p.trend.change30Pct, 2)} over 30 days.`);
    L.push(`- Positions: ${p.now.positions} tracked${p.now.top3DebtPct != null ? `; the three largest hold ${p.now.top3DebtPct.toFixed(0)}% of the debt` : ""}. ${p.symbol} supplied on Core: ${Math.round(p.now.supplied).toLocaleString("en-US")}.`);
    if (p.swap.into.length) L.push(`- Migration within the E-Mode: ${usd(p.swap.movedUsd)} of ${p.swap.into.join(", ")} now supplied by these wallets (${p.swap.sharePct != null ? p.swap.sharePct.toFixed(1) : "n/a"}% of their ETH collateral).`);
    if (p.carry) L.push(`- Loop economics: ${p.symbol} yields ${p.carry.yieldPct?.toFixed(2) ?? "n/a"}% (30 days) against a ${p.carry.borrowPct.toFixed(2)}% ${p.debtSymbol} borrow rate; at ${p.carry.avgLeverage?.toFixed(1) ?? "n/a"}x the loops earn ${pct(p.carry.roe[0]?.pct)} on equity, turning negative at +${p.carry.breakevenBps ?? "n/a"} bps.`);
    if (p.ltSim) L.push(`- LT path: at a ${p.ltSim.ltPct}% LT, a 2-point cut would leave ${usd(p.ltSim.nextStep.liquidatableUsd)} (${p.ltSim.nextStep.sharePct.toFixed(2)}% of tracked collateral) liquidatable, ${p.ltSim.nextStep.under2M && p.ltSim.nextStep.under5Pct ? "within" : "outside"} the ARFC rule; ${p.ltSim.maxSafePoints} consecutive points stay within it.`);
    for (const s of p.steps) L.push(`- ${s.stage}: ${s.label} — ${s.doneAt ? `done${s.doneAt !== "before tracking" ? ` (${day(s.doneAt)})` : ""}` : s.stage.startsWith("Follow-up") ? "not triggered" : s.stage.startsWith("Natural") ? (p.trend.declining ? "exposure declining" : "ongoing") : "pending"}.`);
    L.push("");
  }
  const changes = plans.flatMap((p) => p.changes.filter((c) => c.timestamp >= monthStart)).sort((a, b) => a.block - b.block);
  const seen = new Set<string>();
  L.push(`## On-chain changes in ${month}`, "");
  if (!changes.length) L.push("No parameter change on the assets in scope this month.", "");
  else {
    L.push("| Date | Change | Transaction |", "|---|---|---|");
    for (const c of changes) {
      const k = `${c.txHash}:${c.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      L.push(`| ${day(c.timestamp)} | ${c.text} | [${c.txHash.slice(0, 10)}…](https://etherscan.io/tx/${c.txHash}) |`);
    }
    L.push("");
  }
  L.push("## Method", "");
  L.push("Debt is attributed to each collateral asset pro rata to the borrower's collateral mix, as in the ARFC. Figures cover the largest holders of each asset tracked by the site, which hold nearly all of each reserve. Daily history is read at 00:00 UTC. Loop returns use 30-day exchange-rate growth and the current borrow rate. The LT simulation holds today's positions constant.", "");
  return { markdown: L.join("\n"), month, generatedAt: now.toISOString() };
}


const n0 = (n: number | null | undefined, d = 0) => (n == null || !Number.isFinite(n) ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: d }));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Loop positions report: market, every tracked position, liquidations. One asset or all. */
export async function buildLoopsReport(only?: string): Promise<{ markdown: string; generatedAt: string }> {
  const assets = ASSETS.filter((a) => !only || a.symbol === only);
  const data = (await Promise.all(assets.map((a) => getLoops(a).then((d) => ({ a, d })).catch(() => null)))).filter((x): x is NonNullable<typeof x> => !!x);
  const now = new Date();
  const L: string[] = [];
  L.push(only ? `# ${only} loop positions on Aave V3 Core` : "# Loop positions on Aave V3 Core, all tracked assets", "");
  L.push(`Read on-chain on ${day(now.toISOString())}. Every position backing $10k+ of debt plus the largest holders; debt is attributed pro rata to each wallet's collateral mix.`, "");
  if (data.length > 1) {
    L.push("## Summary", "", "| Asset | Supplied | Tracked positions | Collateral | Debt backed | Debt ÷ collateral | HF below alert |", "|---|---:|---:|---:|---:|---:|---:|");
    for (const { a, d } of [...data].sort((x, y) => y.d.market.trackedDebtUsd - x.d.market.trackedDebtUsd)) {
      const m = d.market;
      L.push(`| ${a.symbol} | ${n0(m.suppliedTokens)} (${usd(m.suppliedUsd)}) | ${m.tracked} | ${usd(m.trackedSupplied * m.priceUsd)} | ${usd(m.trackedDebtUsd)} | ${m.debtToCollateralPct?.toFixed(1) ?? "n/a"}% | ${m.underAlert} |`);
    }
    L.push("");
  }
  for (const { a, d } of data) {
    const m = d.market;
    L.push(`## ${a.symbol}`, "");
    L.push(`- Supplied on Core: ${n0(m.suppliedTokens)} ${a.symbol} (${usd(m.suppliedUsd)}), ${m.holders ?? "n/a"} holders; ${m.frozen ? "frozen" : "not frozen"}, LTV ${m.ltvPct}%, LT ${m.liquidationThresholdPct}%.`);
    L.push(`- Tracked: ${m.tracked} positions holding ${n0(m.trackedSupplied)} ${a.symbol} (${m.trackedSharePct?.toFixed(1) ?? "n/a"}% of the reserve), backing ${usd(m.trackedDebtUsd)} of ${m.debtSymbol === "Stablecoins" ? "stablecoin" : m.debtSymbol} debt; ${m.underAlert} below a ${HF_ALERT} health factor.`);
    if (m.debtSymbol !== "Stablecoins" && m.debtBorrowApy != null) L.push(`- ${m.debtSymbol} borrow rate: ${m.debtBorrowApy.toFixed(2)}%.`);
    L.push("", "| # | Holder | Tag | Supplied | Debt backed | Health factor | Leverage | Drop to liquidation |", "|---:|---|---|---:|---:|---:|---:|---:|");
    for (const p of d.positions) {
      L.push(`| ${p.rank} | [${short(p.address)}](https://etherscan.io/address/${p.address}) | ${p.tag?.label ?? p.ens ?? p.contractName ?? ""} | ${n0(p.supplied, 2)} | ${usd(p.debtUsd)} | ${p.healthFactor ? p.healthFactor.toFixed(3) : "n/a"} | ${p.leverage ? `${p.leverage.toFixed(1)}x` : "n/a"} | ${p.dropToLiquidationPct != null ? `${p.dropToLiquidationPct.toFixed(1)}%` : "n/a"} |`);
    }
    const liqs = d.positions.flatMap((p) => p.liquidations.map((l) => ({ ...l, address: p.address }))).sort((x, y) => y.timestamp.localeCompare(x.timestamp));
    L.push("");
    if (liqs.length) {
      L.push("Liquidations of tracked holders:", "", "| Date | Holder | Collateral seized | Debt repaid |", "|---|---|---:|---:|");
      for (const l of liqs.slice(0, 30)) L.push(`| ${day(l.timestamp)} | ${short(l.address)} | ${n0(l.collateralAmount, 3)} ${l.collateralSymbol} | ${usd(l.debtUsd)} |`);
      L.push("");
    }
  }
  return { markdown: L.join("\n"), generatedAt: now.toISOString() };
}
