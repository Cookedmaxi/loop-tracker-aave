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
    | { kind: "debtRateChange" }
    | { kind: "reserveFactorAtLeast"; pct: number }
    | { kind: "ltCut" };
  note?: string;
}

export interface AssetPlan {
  resolution: string;
  /** rate: WETH loops, unwound by the borrow rate if needed. lt: stablecoin borrowers, unwound by LT cuts if needed. */
  path: "rate" | "lt";
  pathLabel: string;
  /** Reserve liquidation threshold when the ARFC was written, to spot LT cuts. */
  ltBaselinePct?: number;
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
    path: "rate",
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
  osETH: {
    resolution: "Deprecate",
    path: "rate",
    pathLabel: "Freeze, migrate, rate path last",
    baseline: { date: "2026-11-09", collateralUsd: 279.4e6, debtUsd: 256.6e6, revenueUsd: 0.79e6 },
    eModes: [1],
    swapInto: [
      { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
      { symbol: "weETH", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
      { symbol: "cbETH", address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704" },
    ],
    steps: [
      { stage: "Initial measures", label: "osETH frozen: LTV 0, including the 93% LTV in the ETH-correlated E-Mode", detect: { kind: "frozen" } },
      { stage: "Natural unwinding", label: "Loops swap into wstETH, weETH, cbETH or WETH, already collateral in the same E-Mode; issuer and largest borrowers engaged", note: "No further measure while exposure declines." },
      { stage: "Follow-up, last resort", label: "WETH base borrow rate up to +100 bps in 50 bps steps, with a reserve factor rise holding the supply rate and Merkl rebates for WETH borrowers without rsETH or osETH", detect: { kind: "debtRateChange" }, note: "osETH shares its E-Mode with other ETH collateral, so its exposure cannot be reduced through the category LT." },
    ],
    notes: [
      "Supply has risen to 122.9k osETH, close to its 123,000 supply cap; the ten largest positions back 66% of the debt.",
      "Nearly all osETH collateral backs WETH debt at around 14 times leverage.",
    ],
  },
  LBTC: {
    resolution: "Migrate to V4",
    path: "lt",
    pathLabel: "Freeze, migrate to V4, LT cuts last",
    ltBaselinePct: 75,
    baseline: { date: "2026-11-09", collateralUsd: 177.4e6, debtUsd: 72.1e6, revenueUsd: 0.35e6 },
    eModes: [],
    swapInto: [],
    steps: [
      { stage: "Initial measures", label: "LBTC frozen: LTV 70% → 0 (84% in E-Mode → 0)", detect: { kind: "frozen" } },
      { stage: "Natural unwinding", label: "Positions migrate to a dedicated LBTC spoke on the Aave V4 Ethereum Core Hub, or repay", note: "No further measure while exposure declines." },
      { stage: "Follow-up, last resort", label: "Liquidation threshold cut in steps of up to 2 points, each leaving less than $2M or 5% of the remaining collateral liquidatable", detect: { kind: "ltCut" } },
    ],
    notes: [
      "USDT and USDC make up 97% of the debt backed by LBTC.",
      "Supply sat at the 2,690 LBTC cap from mid-September and has declined to 2,393 LBTC. The BTC-correlated E-Modes, where LBTC backs WBTC and cbBTC borrowing, are left unchanged.",
    ],
  },
  tBTC: {
    resolution: "Deprecate",
    path: "lt",
    pathLabel: "Frozen, LT cuts last",
    ltBaselinePct: 78,
    baseline: { date: "2026-11-09", collateralUsd: 117.4e6, debtUsd: 52.9e6, revenueUsd: 0.47e6 },
    eModes: [],
    swapInto: [],
    steps: [
      { stage: "Initial measures", label: "tBTC frozen, LTV 0 (since 31 October)", detect: { kind: "frozen" } },
      { stage: "Initial measures", label: "tBTC reserve factor 50% → 99% (tBTC is still borrowed, $185.6k)", detect: { kind: "reserveFactorAtLeast", pct: 99 } },
      { stage: "Natural unwinding", label: "Borrowers repay or migrate; issuer engaged", note: "No further measure while exposure declines." },
      { stage: "Follow-up, last resort", label: "Liquidation threshold cut in steps of up to 2 points, each leaving less than $2M or 5% of the remaining collateral liquidatable", detect: { kind: "ltCut" } },
    ],
    notes: [
      "309 borrowing positions, mainly DAI, USDC and USDT.",
      "Supply has declined to 1,599 tBTC, its lowest level over the past year.",
    ],
  },
  rETH: {
    resolution: "Deprecate",
    path: "lt",
    pathLabel: "Freeze, migrate, LT cuts last",
    ltBaselinePct: 79,
    baseline: { date: "2026-11-09", collateralUsd: 81.8e6, debtUsd: 35.4e6, revenueUsd: 0.22e6 },
    eModes: [],
    swapInto: [],
    steps: [
      { stage: "Initial measures", label: "rETH frozen: LTV 75% → 0, and 93% → 0 in the ETH-correlated E-Mode", detect: { kind: "frozen" } },
      { stage: "Initial measures", label: "rETH reserve factor 15% → 99% (rETH is still borrowed, $101.1k)", detect: { kind: "reserveFactorAtLeast", pct: 99 } },
      { stage: "Natural unwinding", label: "Borrowers repay, or move into wstETH, weETH or cbETH within the ETH-correlated E-Mode", note: "No further measure while exposure declines." },
      { stage: "Follow-up, last resort", label: "Liquidation threshold cut in steps of up to 2 points, each leaving less than $2M or 5% of the remaining collateral liquidatable", detect: { kind: "ltCut" } },
    ],
    notes: [
      "317 borrowing positions; USDC makes up 67% of the debt and USDT 20%.",
      "Supply has held between 31.6k and 41.5k rETH over the past year.",
    ],
  },
};
