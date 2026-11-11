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
