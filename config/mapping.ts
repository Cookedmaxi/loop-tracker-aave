// Reserves the mapping looks at for each wallet: what it borrows and what else it posts as
// collateral on Aave V3 Core, plus Spark for wallets that loop on two venues.

import type { Address } from "./assets";

export const MAPPING = {
  /** Holders below this value (USD) are summarised, not listed. */
  dustUsd: 50,
  /** Most holders listed per asset. */
  maxHolders: 800,
  /** Spark (SparkLend) Pool on Ethereum, checked for loopers. */
  sparkPool: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987" as Address,
};

/** Debt reserves read per borrower (variable debt). */
export const DEBT_RESERVES: { symbol: string; address: Address }[] = [
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
  { symbol: "GHO", address: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f" },
  { symbol: "USDe", address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3" },
  { symbol: "USDS", address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F" },
  { symbol: "RLUSD", address: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD" },
  { symbol: "EURC", address: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c" },
  { symbol: "PYUSD", address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8" },
];

/** Other collateral read per borrower (aToken balance). */
export const COLLATERAL_RESERVES: { symbol: string; address: Address }[] = [
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
  { symbol: "weETH", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
  { symbol: "cbETH", address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704" },
  { symbol: "rsETH", address: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7" },
  { symbol: "osETH", address: "0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38" },
  { symbol: "rETH", address: "0xae78736Cd615f374D3085123A210448E74Fc6393" },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  { symbol: "LBTC", address: "0x8236a87084f8B84306f72007F36F2618A5634494" },
  { symbol: "tBTC", address: "0x18084fbA666a33d37592fA2633fD49a74DD93a88" },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { symbol: "sUSDe", address: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" },
];
