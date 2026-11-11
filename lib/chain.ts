// On-chain reads through the RPC: reserve settings, prices, balances, debt and health factors.

import { createPublicClient, formatUnits, http, parseAbi, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { AAVE_V3_CORE, WETH, type Address, type LoopAsset } from "@/config/assets";

const poolAbi = parseAbi([
  "struct ReserveConfigurationMap { uint256 data; }",
  "struct ReserveData { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }",
  "function getReserveData(address asset) view returns (ReserveData)",
  "function getConfiguration(address asset) view returns (ReserveConfigurationMap)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const oracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256)"]);

let _client: PublicClient | null = null;
export function client(): PublicClient {
  const url = process.env.RPC_URL;
  if (!url) throw new Error("RPC_URL is not set. Add it to the environment variables.");
  if (!_client) _client = createPublicClient({ chain: mainnet, transport: http(url), batch: { multicall: true } });
  return _client;
}

export interface Reserve {
  symbol: string;
  underlying: Address;
  debtSymbol: string;
  debtUnderlying: Address;
  aToken: Address;
  variableDebtToken: Address;
  /** Every asset counted as this collateral's debt (one for loops, several for stablecoins). */
  debtAssets: { symbol: string; address: Address }[];
}

/** Fills in the aToken and the debt token from the Pool when the config leaves them out. */
export async function resolveReserve(asset: LoopAsset): Promise<Reserve> {
  const debtUnderlying = asset.debtUnderlying ?? WETH;
  const c = client();
  const [aToken, variableDebtToken] = await Promise.all([
    asset.aToken ?? c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getReserveData", args: [asset.underlying] }).then((r) => r.aTokenAddress),
    asset.variableDebtToken ?? c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getReserveData", args: [debtUnderlying] }).then((r) => r.variableDebtTokenAddress),
  ]);
  const debtSymbol = asset.debtSymbol ?? "WETH";
  return { symbol: asset.symbol, underlying: asset.underlying, debtSymbol, debtUnderlying, aToken, variableDebtToken, debtAssets: asset.debtAssets ?? [{ symbol: debtSymbol, address: debtUnderlying }] };
}

const bits = (data: bigint, from: number, to: number) => Number((data >> BigInt(from)) & ((1n << BigInt(to - from + 1)) - 1n));

export interface ChainMarket {
  suppliedTokens: number; priceUsd: number; debtPriceUsd: number;
  ltvPct: number; liquidationThresholdPct: number; active: boolean; frozen: boolean; paused: boolean; supplyCap: number; borrowCap: number;
}

export async function readMarket(r: Reserve): Promise<ChainMarket> {
  const c = client();
  const [supply, decimals, price, debtPrice, config] = await Promise.all([
    c.readContract({ address: r.aToken, abi: erc20Abi, functionName: "totalSupply" }),
    c.readContract({ address: r.aToken, abi: erc20Abi, functionName: "decimals" }),
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.underlying] }),
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [r.debtUnderlying] }),
    c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getConfiguration", args: [r.underlying] }),
  ]);
  const d = config.data;
  return {
    suppliedTokens: Number(formatUnits(supply, decimals)),
    priceUsd: Number(formatUnits(price, 8)),       // Aave V3 Core oracle quotes USD with 8 decimals
    debtPriceUsd: Number(formatUnits(debtPrice, 8)),
    ltvPct: bits(d, 0, 15) / 100,
    liquidationThresholdPct: bits(d, 16, 31) / 100,
    active: bits(d, 56, 56) === 1,
    frozen: bits(d, 57, 57) === 1,
    paused: bits(d, 60, 60) === 1,
    borrowCap: bits(d, 80, 115),
    supplyCap: bits(d, 116, 151),
  };
}

export interface ChainPosition { address: Address; supplied: number; debt: number; totalCollateralUsd: number; totalDebtUsd: number; healthFactor: number | null }

export async function readPositions(r: Reserve, holders: Address[]): Promise<ChainPosition[]> {
  const c = client();
  const [aDec, dDec] = await Promise.all([
    c.readContract({ address: r.aToken, abi: erc20Abi, functionName: "decimals" }),
    c.readContract({ address: r.variableDebtToken, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return Promise.all(holders.map(async (address) => {
    const [supplied, debt, account] = await Promise.all([
      c.readContract({ address: r.aToken, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      c.readContract({ address: r.variableDebtToken, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      c.readContract({ address: AAVE_V3_CORE.pool, abi: poolAbi, functionName: "getUserAccountData", args: [address] }),
    ]);
    const [totalCollateralBase, totalDebtBase, , , , hf] = account;
    return {
      address,
      supplied: Number(formatUnits(supplied, aDec)),
      debt: Number(formatUnits(debt, dDec)),
      totalCollateralUsd: Number(formatUnits(totalCollateralBase, 8)),
      totalDebtUsd: Number(formatUnits(totalDebtBase, 8)),
      healthFactor: totalDebtBase === 0n ? null : Number(formatUnits(hf, 18)),
    };
  }));
}
