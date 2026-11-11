// Peg, backing and supply of the collateral asset, read every ten minutes: Kelp's own
// contracts for the exchange rate and backing, the token for its supply, CoinGecko for
// the market price. About ten eth_calls per read; CoinGecko is called once per read.

import { formatUnits, parseAbi } from "viem";
import { AAVE_V3_CORE, type LoopAsset } from "@/config/assets";
import { RISK } from "@/config/risk";
import { client, resolveReserve } from "./chain";
import type { RiskResponse } from "./types";

const lrtOracle = parseAbi(["function rsETHPrice() view returns (uint256)", "function getAssetPrice(address) view returns (uint256)"]);
const depositPool = parseAbi(["function getTotalAssetDeposits(address) view returns (uint256)", "function paused() view returns (bool)"]);
const erc20 = parseAbi(["function totalSupply() view returns (uint256)"]);
const aaveOracle = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);

const TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<RiskResponse | null> }>();

async function marketPriceEth(id: string): Promise<{ eth: number; usd: number; change24h: number | null } | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=eth,usd&include_24hr_change=true`, { headers, cache: "no-store", signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`CoinGecko answered ${res.status}`);
  const d = (await res.json())[id];
  return d?.eth ? { eth: Number(d.eth), usd: Number(d.usd), change24h: d.eth_24h_change != null ? Number(d.eth_24h_change) : null } : null;
}

async function read(asset: LoopAsset): Promise<RiskResponse | null> {
  const p = RISK[asset.symbol];
  if (!p) return null;
  const c = client();
  const r = await resolveReserve(asset);
  const warnings: string[] = [];

  const [supply, aSupply, kelpRate, paused, aavePrice, aaveDebtPrice, market] = await Promise.all([
    c.readContract({ address: asset.underlying, abi: erc20, functionName: "totalSupply" }),
    c.readContract({ address: r.aToken, abi: erc20, functionName: "totalSupply" }),
    c.readContract({ address: p.oracle, abi: lrtOracle, functionName: "rsETHPrice" }).catch(() => null),
    c.readContract({ address: p.depositPool, abi: depositPool, functionName: "paused" }).catch(() => null),
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: aaveOracle, functionName: "getAssetPrice", args: [asset.underlying] }),
    c.readContract({ address: AAVE_V3_CORE.oracle, abi: aaveOracle, functionName: "getAssetPrice", args: [r.debtUnderlying] }),
    marketPriceEth(p.coingeckoId).catch((e) => { warnings.push(`Market price unavailable: ${e instanceof Error ? e.message : "failed"}`); return null; }),
  ]);
  if (kelpRate == null) warnings.push("Kelp's oracle did not answer; the exchange rate is Aave's oracle instead.");

  const backing = await Promise.all(p.backingAssets.map(async (b) => {
    const [amount, price] = await Promise.all([
      c.readContract({ address: p.depositPool, abi: depositPool, functionName: "getTotalAssetDeposits", args: [b.address] }).catch(() => null),
      c.readContract({ address: p.oracle, abi: lrtOracle, functionName: "getAssetPrice", args: [b.address] }).catch(() => null),
    ]);
    const tokens = amount == null ? null : Number(formatUnits(amount, 18));
    const ethPrice = price == null ? (b.symbol === "ETH" ? 1 : null) : Number(formatUnits(price, 18));
    return { symbol: b.symbol, address: b.address, tokens, ethPrice, eth: tokens != null && ethPrice != null ? tokens * ethPrice : null };
  }));
  if (backing.every((b) => b.tokens == null)) warnings.push("Kelp's deposit pool did not answer: backing unavailable.");

  const aaveRate = Number(aavePrice) / Number(aaveDebtPrice);
  const rate = kelpRate != null ? Number(formatUnits(kelpRate, 18)) : aaveRate;
  const totalSupply = Number(formatUnits(supply, 18));
  const backedEth = backing.reduce((s, b) => s + (b.eth ?? 0), 0);
  return {
    symbol: asset.symbol, issuer: p.issuer, website: p.website, readAt: new Date().toISOString(),
    exchangeRate: rate, aaveRate, rateSource: kelpRate != null ? "Kelp oracle" : "Aave oracle",
    market: market ? { priceEth: market.eth, priceUsd: market.usd, change24hPct: market.change24h, pegPct: (market.eth / rate - 1) * 100, source: "CoinGecko" } : null,
    supply: totalSupply, onAave: Number(formatUnits(aSupply, 18)), onAavePct: totalSupply > 0 ? (Number(formatUnits(aSupply, 18)) / totalSupply) * 100 : null,
    depositsPaused: paused,
    backing: backing.map((b) => ({ ...b, sharePct: backedEth > 0 && b.eth != null ? (b.eth / backedEth) * 100 : null })),
    backedEth: backedEth || null, backingPerToken: backedEth && totalSupply ? backedEth / totalSupply : null,
    exit: p.exit, findings: p.findings, findingsSource: p.findingsSource, incidents: p.incidents, warnings,
  };
}

export function getRisk(asset: LoopAsset, fresh = false): Promise<RiskResponse | null> {
  const hit = cache.get(asset.symbol);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;
  const value = read(asset).catch((e) => { cache.delete(asset.symbol); throw e; });
  cache.set(asset.symbol, { at: Date.now(), value });
  return value;
}
