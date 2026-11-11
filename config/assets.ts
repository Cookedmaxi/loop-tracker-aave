// ─────────────────────────────────────────────────────────────────────────────
// Tracked assets. To add one: append an entry and drop a logo in
// /public/assets/<symbol>.png. Nothing else changes.
//
// Only `symbol` and `underlying` are required. The aToken and the debt token
// are read from the Aave Pool; set them here only to override.
// ─────────────────────────────────────────────────────────────────────────────

export type Address = `0x${string}`;

export interface LoopAsset {
  symbol: string;
  underlying: Address;
  /** Asset borrowed against it in the loop. Defaults to WETH. */
  debtSymbol?: string;
  debtUnderlying?: Address;
  aToken?: Address;
  variableDebtToken?: Address;
  /** When the debt is spread over several assets (stablecoins): all of them. debtUnderlying is the one used for pricing. */
  debtAssets?: { symbol: string; address: Address }[];
  /** Most holders scanned for this asset (safety cap). Defaults to MAX_HOLDERS_SCANNED. */
  maxHolders?: number;
}

export const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

export const AAVE_V3_CORE = {
  name: "Aave V3 Core",
  /** TokenLogic API names for this instance. */
  marketKey: "ethereum-core-v3",
  ratesMarket: "Aave V3",
  chain: "ethereum",
  /** Aave app name of this instance, for links. */
  appMarket: "proto_mainnet_v3",
  pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as Address,
  oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2" as Address,
};

/** Assets borrowed against BTC wrappers and rETH: debt is the sum of these, priced at USDC. */
const STABLE_DEBT = {
  debtSymbol: "Stablecoins",
  debtUnderlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
  debtAssets: [
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address },
    { symbol: "GHO", address: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f" as Address },
  ],
};

export const ASSETS: LoopAsset[] = [
  {
    symbol: "rsETH",
    underlying: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7",
    aToken: "0x2D62109243b87C4bA3EE7bA1D91B0dD0A074d7b1",
    variableDebtToken: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
  },
  { symbol: "osETH", underlying: "0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38" },
  { symbol: "LBTC", underlying: "0x8236a87084f8B84306f72007F36F2618A5634494", ...STABLE_DEBT },
  { symbol: "tBTC", underlying: "0x18084fbA666a33d37592fA2633fD49a74DD93a88", ...STABLE_DEBT },
  { symbol: "rETH", underlying: "0xae78736Cd615f374D3085123A210448E74Fc6393", ...STABLE_DEBT },
];

/** Holders always shown, largest first, even without debt. */
export const TOP_HOLDERS = 12;

/** Every position backing at least this much debt is tracked. Holders are scanned from the largest
 *  down to the smallest balance that could still back this much debt. */
export const MIN_DEBT_USD = 10_000;

/** Safety cap on holders scanned per asset. */
export const MAX_HOLDERS_SCANNED = 1500;

/** Health factors below this are flagged. */
export const HF_ALERT = 1.03;

/** Seconds an on-chain answer is reused before the chain is read again. */
export const CACHE_SECONDS = 60;
