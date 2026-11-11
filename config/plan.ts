// ─────────────────────────────────────────────────────────────────────────────
// The offboarding plan the site tracks: "Collateral Restructuring: Aave V3 Core"
// (LlamaRisk, figures as of 2 November 2026). One entry per tracked asset; an asset
// without an entry simply has no Offboarding tab content.
//
// Figures marked "plan" are quoted from the proposal and never change. Everything
// else on the tab is read from the chain.
// ─────────────────────────────────────────────────────────────────────────────

import type { Address } from "./assets";

export interface PlanStep {
  month: number;
  label: string;
  /** Marked done when this on-chain change is seen. */
  detect?: { asset: "debt" | "collateral"; reserveFactorAtLeastPct?: number; frozen?: boolean };
  /** Only happens if this holds (shown as a rule, evaluated on the tab). */
  condition?: "loop-debt-fell-less-than-25pct";
}

export interface PlanTrigger {
  label: string;          // what happens
  rule: string;           // in words
  debtBelowUsd: number;   // fires when the debt backed by the asset falls below this
}

export interface AssetPlan {
  resolution: string;
  path: "rate" | "lt";
  pathLabel: string;
  /** Plan figures, 2 November 2026. */
  baseline: { date: string; collateralUsd: number; debtUsd: number };
  /** E-Mode categories the loops sit in. */
  eModes: number[];
  /** Plan's own carry figures, for reference next to the live ones. */
  planCarry: { yieldPct: number; borrowPct: number; breakevenBps: number; roeAt100BpsPct: number };
  steps: PlanStep[];
  triggers: PlanTrigger[];
  notes: string[];
}

export const PLAN = {
  title: "Collateral Restructuring: Aave V3 Core",
  source: "LlamaRisk, 2 November 2026",
  /** First block read for parameter changes: 22 October 2026, ten days before the plan's figures. */
  timelineFromBlock: 26_250_000,
  configurator: "0x64b761D848206f447Fe2dd461b0c635Ec39EbB27" as Address,
  /** WETH rate steps on the rate path, in basis points over the current curve. */
  rateSteps: [0, 50, 100],
};

export const ASSET_PLANS: Record<string, AssetPlan> = {
  rsETH: {
    resolution: "Offboard",
    path: "rate",
    pathLabel: "Rate path",
    baseline: { date: "2026-11-02", collateralUsd: 739.3e6, debtUsd: 676.5e6 },
    eModes: [3],
    planCarry: { yieldPct: 2.57, borrowPct: 1.97, breakevenBps: 85, roeAt100BpsPct: -1.8 },
    steps: [
      { month: 0, label: "rsETH frozen, LTV 0 (since 18 April)", detect: { asset: "collateral", frozen: true } },
      { month: 0, label: "WETH borrow rate +50 bps, reserve factor 15% → 32%, Merkl rebates for bluechip WETH borrowers", detect: { asset: "debt", reserveFactorAtLeastPct: 32 } },
      { month: 1, label: "WETH borrow rate +100 bps, reserve factor 43%", detect: { asset: "debt", reserveFactorAtLeastPct: 43 }, condition: "loop-debt-fell-less-than-25pct" },
      { month: 2, label: "Hold, then reassess: E-Mode exit, rate and reserve factor back to 15%, end of Merkl campaign" },
    ],
    triggers: [
      { label: "E-Mode 3 LT cuts start", rule: "rsETH-backed WETH debt below $50M", debtBelowUsd: 50e6 },
    ],
    notes: [
      "The three largest positions back 67% of the WETH debt and are to be approached about moving their loops to wstETH, weETH or cbETH.",
      "rsETH unwinds through Kelp's 15 to 21 day withdrawal queue: rsETH sent to the withdrawal manager shows in Last tx.",
    ],
  },
};
