// Health of every data source, for the Data tab. Each check is timed and never throws.

import { AAVE_V3_CORE, ASSETS, CACHE_SECONDS } from "@/config/assets";
import { client, resolveReserve } from "@/lib/chain";
import { getHolderCount } from "@/lib/blockscout";
import { hasTokenLogicKey, latestRate, reserveLatest } from "@/lib/tokenlogic";
import { storageKind, hkeys } from "@/lib/store";
import { savedHistory } from "@/lib/events";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Check = { name: string; ok: boolean | null; ms: number | null; detail: string; asOf: string | null; usedFor: string };

async function timed(name: string, usedFor: string, fn: () => Promise<{ detail: string; asOf?: string | null; ok?: boolean | null }>): Promise<Check> {
  const t = Date.now();
  try {
    const r = await fn();
    return { name, usedFor, ok: r.ok === undefined ? true : r.ok, ms: Date.now() - t, detail: r.detail, asOf: r.asOf ?? null };
  } catch (e) {
    return { name, usedFor, ok: false, ms: Date.now() - t, detail: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "Failed", asOf: null };
  }
}

export async function GET() {
  const asset = ASSETS[0];
  const checks = await Promise.all([
    timed("Ethereum RPC", "Balances, debt and health factor of each holder; reserve settings and caps; oracle prices; Aave Pool events (Supply, Withdraw, Borrow, Repay, Liquidation).", async () => {
      const b = await client().getBlock();
      const age = Math.round(Date.now() / 1000 - Number(b.timestamp));
      return { detail: `Block ${Number(b.number).toLocaleString("en-US")}, mined ${age}s ago`, asOf: new Date(Number(b.timestamp) * 1000).toISOString(), ok: age < 120 };
    }),
    timed("TokenLogic API · reserve data", "Supply, price, utilization, supply and borrow APY of the reserve; liquidations on the market (needs TOKENLOGIC_API_KEY).", async () => {
      if (!hasTokenLogicKey()) return { detail: "No TOKENLOGIC_API_KEY set: the site uses on-chain figures and public rates instead.", ok: null };
      const r = await resolveReserve(asset);
      const { row, lastUpdated } = await reserveLatest(AAVE_V3_CORE.marketKey, r.underlying);
      return { detail: row ? `${asset.symbol}: ${Number(row.deposits).toLocaleString("en-US", { maximumFractionDigits: 0 })} deposited` : `No row for ${asset.symbol}`, asOf: lastUpdated, ok: !!row };
    }),
    timed("TokenLogic API · public rates", "Supply and borrow APY when no API key is set.", async () => {
      const r = await latestRate(asset.symbol, AAVE_V3_CORE.ratesMarket, AAVE_V3_CORE.chain);
      return { detail: r ? `${asset.symbol} supply APY ${((r.deposit_apy ?? 0) * 100).toFixed(2)}%` : "No rate returned", asOf: r?.timestamp ?? null, ok: !!r };
    }),
    timed("Blockscout", "List of the top holders, holder count, public labels and contract names, and token transfers that are not Aave actions.", async () => {
      const r = await resolveReserve(asset);
      const n = await getHolderCount(r.aToken);
      return { detail: n == null ? "No holder count returned" : `${n} ${asset.symbol} holders on Aave`, ok: n != null };
    }),
    timed("Shared storage", "Tags added on the site, and the saved Aave event history (so each visit reads only new blocks).", async () => {
      const kind = storageKind();
      if (kind === "none") return { detail: "Upstash is not connected: tags cannot be added and the event history is kept in server memory only.", ok: false };
      const tags = await hkeys("community-tags");
      return { detail: `${kind === "redis" ? "Upstash Redis" : "Local file (development)"} · ${tags.length} tag${tags.length === 1 ? "" : "s"} added on the site` };
    }),
  ]);
  const history = await savedHistory().catch(() => []);
  return Response.json({ checkedAt: new Date().toISOString(), cacheSeconds: CACHE_SECONDS, checks, history });
}
