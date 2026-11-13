// GET /api/holders?asset=rsETH|all — every holder above the dust line, as CSV, from the holder mapping.

import { ASSETS } from "@/config/assets";
import { getMapping } from "@/lib/mapping";
import type { MappingHolder } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const COLS = ["asset", "rank", "address", "entity", "tag", "kind", "is_contract", "contract_name", "ens", "supplied", "supplied_usd", "share_of_reserve_pct",
  "debt_backed_usd", "debts", "other_collateral", "account_collateral_usd", "account_debt_usd", "health_factor", "ltv_pct", "leverage", "drop_to_liquidation_pct", "spark_debt_usd", "debank"];

const cell = (v: unknown) => {
  if (v == null) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const list = (xs: { symbol: string; amount: number }[]) => xs.map((x) => `${x.symbol}:${Math.round(x.amount * 1e4) / 1e4}`).join(" ");

function row(asset: string, h: MappingHolder) {
  return [asset, h.rank, h.address, h.entity, h.tag, h.kind, h.isContract ? 1 : 0, h.contractName, h.ens, h.supplied, h.suppliedUsd, h.sharePct,
    h.debtBackedUsd, list(h.debts), list(h.otherCollateral), h.totalCollateralUsd, h.totalDebtUsd, h.healthFactor, h.ltvPct, h.leverage, h.dropToLiquidationPct,
    h.spark?.debtUsd ?? null, `https://debank.com/profile/${h.address}`].map(cell).join(",");
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("asset") ?? "all";
  const assets = q === "all" ? ASSETS : ASSETS.filter((a) => a.symbol.toLowerCase() === q.toLowerCase());
  if (!assets.length) return Response.json({ error: `Unknown asset ${q}` }, { status: 400 });
  const maps = await Promise.all(assets.map((a) => getMapping(a).then((m) => ({ a, m })).catch(() => ({ a, m: null }))));
  const lines = [COLS.join(",")];
  for (const { a, m } of maps) for (const h of m?.holders ?? []) lines.push(row(a.symbol, h));
  const missing = maps.filter((x) => !x.m).map((x) => x.a.symbol);
  const date = new Date().toISOString().slice(0, 10);
  const name = `${q === "all" ? "all-assets" : assets[0].symbol}-holders-${date}.csv`;
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, ...(missing.length ? { "x-missing-assets": missing.join(",") } : {}) },
  });
}
