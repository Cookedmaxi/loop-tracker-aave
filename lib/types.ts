import type { Address } from "@/config/assets";

export interface Tag { label: string; entity: string; kind: string }

export interface Position {
  rank: number;
  address: Address;
  tag: Tag | null;
  contractName: string | null;
  ens: string | null;
  isContract: boolean;
  supplied: number;            // collateral asset, tokens
  suppliedUsd: number;
  sharePct: number;            // of the aToken supply
  debt: number;                // loop debt asset, tokens
  debtUsd: number;
  loops: boolean;
  // Account-wide, from Aave getUserAccountData (all collateral, all debt):
  totalCollateralUsd: number;
  totalDebtUsd: number;
  healthFactor: number | null;
  leverage: number | null;
  dropToLiquidationPct: number | null;
  alert: boolean;
  liquidations: { timestamp: string; txHash: string; collateralSymbol: string; collateralAmount: number; debtSymbol: string; debtAmount: number; debtUsd: number }[];
}

export interface Market {
  symbol: string;
  debtSymbol: string;
  venue: string;
  aToken: Address;
  variableDebtToken: Address;
  suppliedTokens: number;
  suppliedInDebtAsset: number; // e.g. rsETH supply valued in ETH
  suppliedUsd: number;
  priceUsd: number;
  debtPriceUsd: number;
  rate: number;                // collateral priced in the debt asset (Aave oracle)
  holders: number | null;
  ltvPct: number;
  liquidationThresholdPct: number;
  frozen: boolean;
  paused: boolean;
  active: boolean;
  supplyCap: number;           // 0 = no cap
  borrowCap: number;
  // Tracked holders only:
  tracked: number;
  looping: number;
  trackedSupplied: number;
  trackedSharePct: number;
  trackedDebt: number;
  trackedDebtUsd: number;
  debtToCollateralPct: number | null;
  netEquityInDebtAsset: number | null;
  underAlert: number;
  top1SharePct: number;
  top3SharePct: number;
  top10SharePct: number;
  // From the TokenLogic API where available:
  source: "TokenLogic API" | "On-chain"; // where supply and prices come from
  supplyApy: number | null;      // %, collateral asset
  debtBorrowApy: number | null;  // %, debt asset
  utilization: number | null;    // %, collateral asset
  borrowedTokens: number | null;
  dataAsOf: string | null;
  notes: string[];
  liquidations90d: number;       // liquidations on the whole market, last 90 days (0 without a key)
}

export interface LoopsResponse { asset: string; asOf: string; market: Market; positions: Position[] }

export interface Tx {
  id: string;
  txHash: string;
  timestamp: string;
  asset: string;               // tracked asset this was loaded for
  wallet: Address;
  walletRank: number | null;   // rank among tracked holders, if any
  walletTag: Tag | null;
  action: string;              // Supply, Withdraw, Borrow, Repay, Transfer, Receive, Send
  amount: number;
  tokenSymbol: string;
  tokenAddress: Address;
  assetRelated: boolean;       // the token is the asset, its aToken or its debt token
  counterparty: Address | null;
  counterpartyTag: Tag | null;
  source: "Aave event" | "Transfer" | "TokenLogic"; // Aave event = read from the Pool on-chain
  detail: string | null;       // e.g. collateral seized in a liquidation
}

export interface HolderDetail {
  address: Address;
  tag: Tag | null;
  name: string | null;
  ens: string | null;
  isContract: boolean;
  creator: Address | null;
  publicTags: string[];
  notes: { source: string; finding: string; linkedEntity: string; confidence: string; date: string }[];
}

export interface Entity { entity: string; kind: string; approach: string; status: string; website: string; x: string }

/** A link between a holder and an entity, added on the site by someone on the team. */
export interface CommunityTag {
  id: string;
  address: Address;
  entity: string;
  label: string | null;
  confidence: "Confirmed" | "Probable" | "Possible";
  reasoning: string;
  links: string[];
  author: string;
  createdAt: string;
}

// ── Offboarding tab ─────────────────────────────────────────────────────────

export interface PlanDay { date: string; block: number; supplied: number; debt: number; debtUsd: number; rate: number }

export interface PlanChange {
  block: number; timestamp: string; txHash: string;
  asset: string;            // symbol, or "E-Mode"
  kind: string;             // event name
  text: string;             // in words
  values: (string | number | boolean)[];
}

export interface PlanResponse {
  symbol: string; debtSymbol: string; title: string; source: string;
  resolution: string; path: "rate" | "lt"; pathLabel: string;
  notes: string[]; warnings: string[];
  baseline: { date: string; collateralUsd: number; debtUsd: number; debtTokens: number | null; supplied: number | null; block: number | null };
  now: { debt: number; debtUsd: number; supplied: number; positions: number; asOf: string };
  history: PlanDay[];
  triggers: { label: string; rule: string; debtBelowUsd: number; met: boolean }[];
  steps: { month: number; label: string; condition: string | null; doneAt: string | null; txHash: string | null }[];
  monthRule: { startedAt: string; due: string; startDebt: number | null; fellPct: number | null; secondStepNeeded: boolean | null } | null;
  carry: {
    yieldPct: number | null; borrowPct: number; borrowAvg30Pct: number | null; reserveFactorPct: number; exchangeRate: number;
    planYieldPct: number; planBorrowPct: number; planBreakevenBps: number;
    avgLeverage: number | null; roe: { bps: number; pct: number | null }[]; breakevenBps: number | null;
    positions: { address: Address; rank: number; label: string | null; leverage: number | null; debtUsd: number; roe: { bps: number; pct: number | null }[]; breakevenBps: number | null }[];
  } | null;
  changes: PlanChange[];
}
