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
  stage: string;          // "Initial measures", "Natural unwinding", "Follow-up, last resort"
  label: string;
  /** Marked done when this is seen on-chain. */
  detect?:
    | { kind: "frozen" }
    | { kind: "emodeCollateralAdded"; category: number; assets: string[] }
    | { kind: "debtRateChange" };
  note?: string;
}

export interface AssetPlan {
  resolution: string;
  pathLabel: string;
  /** Plan figures at the baseline date. */
  baseline: { date: string; collateralUsd: number; debtUsd: number; revenueUsd: number };
  /** E-Mode categories the loops sit in. */
  eModes: number[];
  /** Collateral that stays on Core and that loops can swap into within their E-Mode. */
  swapInto: { symbol: string; address: Address }[];
  steps: PlanStep[];
  notes: string[];
}

export const PLAN = {
  title: "ARFC: Repositioning Aave V3 Core around Established, Liquid Collateral",
  url: "https://governance.aave.com/t/arfc-repositioning-aave-v3-core-around-established-liquid-collateral/26191",
  source: "LlamaRisk, 9 November 2026",
  /** First block read for parameter changes: 22 October 2026. */
  timelineFromBlock: 26_250_000,
  configurator: "0x64b761D848206f447Fe2dd461b0c635Ec39EbB27" as Address,
  /** WETH rate steps the ARFC allows as the last resort, in basis points over the current curve. */
  rateSteps: [0, 50, 100],
};

export const ASSET_PLANS: Record<string, AssetPlan> = {
  rsETH: {
    resolution: "Offboard",
    pathLabel: "Freeze, migrate, rate path last",
    baseline: { date: "2026-11-09", collateralUsd: 661.8e6, debtUsd: 605.7e6, revenueUsd: 1.85e6 },
    eModes: [3],
    swapInto: [
      { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
      { symbol: "weETH", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
      { symbol: "cbETH", address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704" },
    ],
    steps: [
      { stage: "Initial measures", label: "rsETH frozen, LTV 0 (since April)", detect: { kind: "frozen" } },
      { stage: "Initial measures", label: "wstETH, weETH and cbETH added as collateral to the rsETH E-Mode (93% LTV, 95% LT), so loops can swap collateral instead of repaying", detect: { kind: "emodeCollateralAdded", category: 3, assets: ["wstETH", "weETH", "cbETH"] } },
      { stage: "Natural unwinding", label: "Issuer and largest borrowers engaged on migration to wstETH, weETH, cbETH or V4; progress reported monthly", note: "No further measure while exposure declines." },
      { stage: "Follow-up, last resort", label: "WETH base borrow rate up to +100 bps in 50 bps steps, at most monthly, with a reserve factor rise holding the supply rate and Merkl rebates for WETH borrowers without rsETH or osETH", detect: { kind: "debtRateChange" }, note: "Only if migration has not reduced the exposure; announced on the forum first." },
    ],
    notes: [
      "The remaining debt sits in eleven positions above $0.2M; the three largest hold 69% of it.",
      "rsETH unwinds through Kelp's 15 to 21 day withdrawal queue: rsETH sent to the withdrawal manager shows in Last tx.",
    ],
  },
};
