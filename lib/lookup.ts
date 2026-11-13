// Address lookup: is this wallet a holder, a loop or a borrower on any tracked asset, which
// tracked positions does it control (Safe signer or contract owner), and what do we know about it.

import { formatUnits, isAddress, parseAbi, getAddress } from "viem";
import { normalize } from "viem/ens";
import { ASSETS, MIN_DEBT_USD, type Address } from "@/config/assets";
import { MAPPING } from "@/config/mapping";
import entities from "@/data/entities.json";
import { client, readMarket, readPositions, resolveReserve } from "./chain";
import { listCommunityTags } from "./community";
import { getMapping } from "./mapping";
import { tagOf } from "./tags";
import type { LookupResponse, MappingResponse } from "./types";

const ctl = parseAbi(["function getOwners() view returns (address[])", "function owner() view returns (address)"]);
const poolAbi = parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);

/** Mapping of an asset, if it can be had quickly; the lookup never waits on a cold build for long. */
async function mappingSoon(symbol: string): Promise<MappingResponse | null> {
  const asset = ASSETS.find((a) => a.symbol === symbol)!;
  return Promise.race([getMapping(asset).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 12_000))]);
}

/** Who controls each tracked contract position: Safe signers and owner(). Cached an hour per asset. */
const controlCache = new Map<string, { at: number; value: Promise<Map<string, { via: string; positions: string[] }>> }>();
export function controllers(m: MappingResponse) {
  const hit = controlCache.get(m.symbol);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
  const value = (async () => {
    const c = client();
    const out = new Map<string, { via: string; positions: string[] }>();
    const contracts = m.holders.filter((h) => h.isContract && h.debtBackedUsd >= MIN_DEBT_USD);
    await Promise.all(contracts.map(async (h) => {
      const [owners, owner] = await Promise.all([
        c.readContract({ address: h.address, abi: ctl, functionName: "getOwners" }).catch(() => null),
        c.readContract({ address: h.address, abi: ctl, functionName: "owner" }).catch(() => null),
      ]);
      const add = (who: string, via: string) => { const k = who.toLowerCase(); const e = out.get(k) ?? { via, positions: [] }; e.positions.push(h.address.toLowerCase()); out.set(k, e); };
      for (const o of owners ?? []) add(o, "Safe signer");
      if (owner && !/^0x0{40}$/i.test(owner)) add(owner, "Contract owner");
    }));
    return out;
  })();
  value.catch(() => controlCache.delete(m.symbol));
  controlCache.set(m.symbol, { at: Date.now(), value });
  return value;
}

export async function lookup(input: string): Promise<LookupResponse> {
  const c = client();
  let raw = input.trim();
  let ens: string | null = null;
  if (/\.eth$/i.test(raw)) {
    ens = raw.toLowerCase();
    const resolved = await c.getEnsAddress({ name: normalize(raw) }).catch(() => null);
    if (!resolved) throw new Error(`${raw} does not resolve to an address.`);
    raw = resolved;
  }
  if (!isAddress(raw)) throw new Error("Enter a full Ethereum address (0x followed by 40 hex characters) or an ENS name.");
  const address = getAddress(raw) as Address;
  const low = address.toLowerCase();
  const [perAsset, community, spark] = await Promise.all([
    Promise.all(ASSETS.map(async (asset) => {
      const r = await resolveReserve(asset);
      const [[p], mk, m] = await Promise.all([readPositions(r, [address]), readMarket(r), mappingSoon(asset.symbol)]);
      const row = m?.holders.find((h) => h.address.toLowerCase() === low) ?? null;
      const suppliedUsd = p.supplied * mk.priceUsd;
      const share = p.totalCollateralUsd > 0 ? Math.min(1, suppliedUsd / p.totalCollateralUsd) : 0;
      const debtBackedUsd = p.totalDebtUsd * share;
      const kind = row?.kind ?? (p.supplied <= 0 ? "Not a holder" : p.totalDebtUsd <= 0 ? "Supply only" : "Borrower");
      let controls: LookupResponse["controls"] = [];
      if (m) {
        const map = await controllers(m).catch(() => null);
        const e = map?.get(low);
        if (e) controls = e.positions.map((pos) => { const h = m.holders.find((x) => x.address.toLowerCase() === pos)!; return { asset: asset.symbol, address: h.address, rank: h.rank, debtBackedUsd: h.debtBackedUsd, suppliedUsd: h.suppliedUsd, via: e.via, tag: h.tag }; });
      }
      return {
        holding: {
          symbol: asset.symbol, debtSymbol: r.debtSymbol, kind, rank: row?.rank ?? null, tracked: !!row && (row.debtBackedUsd >= MIN_DEBT_USD || row.rank <= 12),
          supplied: p.supplied, suppliedUsd, sharePct: mk.suppliedTokens ? (p.supplied / mk.suppliedTokens) * 100 : 0,
          debtBackedUsd, totalCollateralUsd: p.totalCollateralUsd, totalDebtUsd: p.totalDebtUsd, healthFactor: p.healthFactor,
          debts: row?.debts ?? [], mappingRead: !!m,
        },
        controls,
      };
    })),
    listCommunityTags().catch(() => []),
    c.readContract({ address: MAPPING.sparkPool, abi: poolAbi, functionName: "getUserAccountData", args: [address] }).then((a) => ({ collateralUsd: Number(formatUnits(a[0], 8)), debtUsd: Number(formatUnits(a[1], 8)), healthFactor: a[1] > 0n ? Number(formatUnits(a[5], 18)) : null })).catch(() => null),
  ]);
  const tag = tagOf(address);
  const info = tag ? (entities as any[]).find((e) => e.entity === tag.entity) ?? null : null;
  const code = await c.getCode({ address }).catch(() => undefined);
  return {
    address, ens, readAt: new Date().toISOString(), isContract: !!code && code !== "0x",
    tag, entity: info ? { name: info.entity, status: info.status ?? null, approach: info.approach ?? null } : null,
    community: community.filter((t) => t.address.toLowerCase() === low),
    holdings: perAsset.map((x) => x.holding),
    controls: perAsset.flatMap((x) => x.controls),
    spark: spark && (spark.collateralUsd > 1 || spark.debtUsd > 1) ? spark : null,
  };
}
