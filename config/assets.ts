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

export const ASSETS: LoopAsset[] = [
  {
    symbol: "rsETH",
    underlying: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7",
    aToken: "0x2D62109243b87C4bA3EE7bA1D91B0dD0A074d7b1",
    variableDebtToken: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
  },
  // { symbol: "wstETH", underlying: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
  // { symbol: "weETH",  underlying: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
];

/** Holders tracked per asset, largest first. */
export const TOP_HOLDERS = 12;

/** Health factors below this are flagged. */
export const HF_ALERT = 1.03;

/** Seconds an on-chain answer is reused before the chain is read again. */
export const CACHE_SECONDS = 60;
