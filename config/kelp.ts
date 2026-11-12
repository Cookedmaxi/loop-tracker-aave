// ─────────────────────────────────────────────────────────────────────────────
// Inputs for the Kelp revenue model (rsETH loops on Aave). Every figure carries its
// source; figures marked "assumption" are ours and are labelled as such on the site.
// Read on 12 November 2026.
// ─────────────────────────────────────────────────────────────────────────────

export const KELP_INPUTS = {
  asOf: "2026-11-12",

  /** Prices: Aave oracle rsETH/USD and the Kelp rsETH/ETH rate (LRTOracle.rsETHPrice). */
  rsethUsd: 2226.96,
  rsethEth: 1.08433,
  /** ETH/USD implied by the two above. */
  ethUsd: 2053.8,

  /** Kelp protocol fee: LRTConfig.protocolFeeInBPS() = 500, applied to the rise in ETH backing at each rsETH price update. */
  feeBps: 500,
  feeSource: "LRTConfig 0x947c…5ec7, protocolFeeInBPS() = 500; LRTOracle mints it as rsETH to the treasury 0x322f…6f78. Kelp's docs still say 10%.",
  /** Fee actually minted (LRTOracle FeeMinted events). */
  feeMinted: { d30: 39.93, d90: 114.12, perDay30: 1.331 },
  maxFeeMintPerDay: 20,
  /** Instant withdrawal: 50 bps fee, currently disabled for ETH. */
  instantWithdrawalFeeBps: 50,
  rsethSupply: 340_582,

  /** Yields, % a year. */
  yields: {
    stethApr7d: 2.33,          // Lido API, 7-day SMA
    rsethNet30d: 2.66,         // rsETH/ETH rate growth, 30 days (net of Kelp fee)
    rsethNet90d: 2.42,         // rsETH/ETH rate growth, 90 days
    rsethNetLlama: 2.55,       // DefiLlama Kelp pool, current (30-day mean 2.69)
    /** Base case: net yield to rsETH holders. Gross = net / (1 − fee). */
    baseNet: 2.55,
  },

  /** Aave WETH on Core today. */
  weth: { borrowApy: 2.05, supplyApy: 1.43, utilization: 82.6, reserveFactor: 15, supply: 2_117_676, debt: 1_749_207, irm: { optimal: 92, base: 0, slope1: 2.2, slope2: 6 } },

  /** rsETH on Aave by chain and market (aToken supply; ETH borrowed = debt attributed pro rata to rsETH). */
  markets: [
    { market: "Ethereum Core (V3)", rseth: 286_382, wethDebt: 284_628, note: "11 loops hold 99.9%; E-Mode, frozen" },
    { market: "Arbitrum (V3)", rseth: 16_466, wethDebt: 16_227, note: "3 loops; frozen since the April exploit" },
    { market: "Base (V3, wrsETH)", rseth: 11_347, wethDebt: 11_383, note: "one loop (also Core #5); frozen" },
    { market: "Aave V4 Ethereum", rseth: 1_209, wethDebt: null, note: "DefiLlama TVL $2.69M" },
    { market: "Linea (V3, wrsETH)", rseth: 564, wethDebt: null, note: "frozen" },
    { market: "Mantle, Prime and others", rseth: 20, wethDebt: null, note: "dust" },
  ],

  /** Largest Core positions (live tracker). */
  positions: [
    { rank: 1, name: "Lido Earn (Mellow strETH subvault)", address: "0xCDfA7EfE670869c6b6be4375654E0b206eF49c89", rseth: 113_216, weth: 112_556, hf: 1.036, leverage: 12.0 },
    { rank: 2, name: "Galaxy Digital (likely)", address: "0x40E93a52F6Af9fCD3b476aeDADD7FeABD9f7AbA8", rseth: 48_434, weth: 47_463, hf: 1.051, leverage: 10.4 },
    { rank: 3, name: "K3 Capital-linked (possible)", address: "0xf7462251C14d2fB83c7aB96367A7985423C83010", rseth: 35_120, weth: 35_249, hf: 1.032, leverage: 12.5 },
    { rank: 4, name: "Unknown", address: "0x755013A759C6c56d95B687ef4B2b9864f3654e60", rseth: 22_560, weth: 22_010, hf: 1.056, leverage: 10.0 },
    { rank: 5, name: "Unknown (also on Arbitrum and Base)", address: "0xd8495B95a3A6a85F4e3baA003E8b7ed1eD85562d", rseth: 20_666, weth: 20_809, hf: 1.023, leverage: 14.0 },
    { rank: 6, name: "Unknown", address: "0x973Ddb8EE2C9CC87e853c8d46253840c63951683", rseth: 17_084, weth: 17_416, hf: 1.010, leverage: 16.7 },
    { rank: 7, name: "CIAN", address: "0x8CB04249117D37fB42F3C805c1a60CfE801A0f6E", rseth: 13_925, weth: 13_721, hf: 1.045, leverage: 11.0 },
    { rank: 8, name: "Unknown", address: "0xBa5d9CC840745AeeeEEDaC5712e32F13AB8ea352", rseth: 8_731, weth: 8_767, hf: 1.026, leverage: 13.5 },
    { rank: 9, name: "Aleph (2 Safes)", address: "0xdE53bCdA6527D2aa15Ec733352C8d393C2E0eC99", rseth: 6_221, weth: 6_388, hf: 1.042, leverage: 10.7 },
  ],

  /** Unwind: ~28 days a cycle (Dialectic), 250 to 290 days in total. */
  cycleDays: 28,
  unwind: { assisted: 252, base: 270, slow: 290 },
  /** B1: a bridge loan clears the loops in about a month. */
  fastExitDays: 30,
  horizonDays: 365,

  /** Isolated market assumptions (ours). */
  isolated: { utilization: 90, reserveFactor: 10 },
} as const;
