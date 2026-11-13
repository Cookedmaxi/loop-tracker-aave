// Batch tagging: paste a list of addresses, the site checks each one against every tracked asset
// (holder, loop or borrower, or signer/owner of a tracked position) and tags the ones that fit.

import { ASSETS, MIN_DEBT_USD } from "@/config/assets";
import { addCommunityTag, listCommunityTags } from "./community";
import { controllers } from "./lookup";
import { getMapping } from "./mapping";
import { tagOf } from "./tags";
import type { MappingResponse } from "./types";

export interface BatchMatch { asset: string; rank: number; kind: string; suppliedUsd: number; debtBackedUsd: number; via?: string; position?: string }
export interface BatchRow {
  address: string; entity: string | null; label: string | null;
  status: "loop" | "borrower" | "holder" | "controls" | "none" | "invalid";
  matches: BatchMatch[]; existing: string | null; added?: boolean; error?: string;
}

const MAX = 500;

/** Lines: `address`, `address, entity`, or `address, entity, label` (comma, tab or semicolon). */
export function parseLines(text: string, defaultEntity: string) {
  const seen = new Set<string>();
  const out: { address: string; entity: string | null; label: string | null; valid: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/0x[0-9a-fA-F]{40}/);
    const parts = line.split(/[,\t;]/).map((s) => s.trim());
    const address = m ? m[0] : parts[0];
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const rest = parts.filter((p) => !/0x[0-9a-fA-F]{40}/.test(p) && p);
    out.push({ address, entity: rest[0] || defaultEntity || null, label: rest[1] || null, valid: !!m });
    if (out.length >= MAX) break;
  }
  return out;
}

export async function checkBatch(text: string, defaultEntity: string): Promise<BatchRow[]> {
  const lines = parseLines(text, defaultEntity.trim());
  const maps = (await Promise.all(ASSETS.map((a) => getMapping(a).catch(() => null)))).filter((m): m is MappingResponse => !!m);
  const ctl = await Promise.all(maps.map((m) => controllers(m).catch(() => null)));
  const community = await listCommunityTags().catch(() => []);
  return lines.map((l) => {
    if (!l.valid) return { address: l.address, entity: null, label: null, status: "invalid", matches: [], existing: null };
    const low = l.address.toLowerCase();
    const matches: BatchMatch[] = [];
    maps.forEach((m, i) => {
      const h = m.holders.find((x) => x.address.toLowerCase() === low);
      if (h) matches.push({ asset: m.symbol, rank: h.rank, kind: h.kind, suppliedUsd: h.suppliedUsd, debtBackedUsd: h.debtBackedUsd });
      const c = ctl[i]?.get(low);
      if (c) for (const pos of c.positions) {
        const p = m.holders.find((x) => x.address.toLowerCase() === pos);
        if (p) matches.push({ asset: m.symbol, rank: p.rank, kind: p.kind, suppliedUsd: p.suppliedUsd, debtBackedUsd: p.debtBackedUsd, via: c.via, position: p.address });
      }
    });
    const direct = matches.filter((x) => !x.via);
    const status: BatchRow["status"] = direct.some((x) => x.kind === "Loop" && x.debtBackedUsd >= MIN_DEBT_USD) ? "loop"
      : direct.some((x) => x.debtBackedUsd >= MIN_DEBT_USD) ? "borrower"
      : matches.some((x) => x.via) ? "controls"
      : direct.length ? "holder" : "none";
    // A team tag that only says "Unknown whale" does not block a real name.
    const team0 = tagOf(l.address as `0x${string}`);
    const team = team0 && !/^unknown/i.test(team0.entity) ? team0 : null;
    const site = community.find((t) => t.address.toLowerCase() === low);
    return { address: l.address, entity: l.entity, label: l.label, status, matches, existing: team ? `${team.entity} (team tag)` : site ? `${site.entity} (site tag by ${site.author})` : null };
  });
}

/** Tags every row whose status is in `include`, skipping rows already tagged. */
export async function applyBatch(rows: BatchRow[], include: BatchRow["status"][], meta: { author: string; reasoning: string; confidence: string; links: string }) {
  for (const r of rows) {
    if (!include.includes(r.status) || r.existing || !r.entity) continue;
    // A signer or owner is tagged on the position it controls, which is what the site tracks.
    const targets = r.status === "controls" ? Array.from(new Set(r.matches.filter((m) => m.position).map((m) => m.position!))) : [r.address];
    try {
      for (const t of targets) {
        await addCommunityTag({
          address: t, entity: r.entity, label: r.label ?? (r.status === "controls" ? `controlled by ${r.address.slice(0, 6)}…${r.address.slice(-4)}` : null),
          confidence: meta.confidence, links: meta.links, author: meta.author,
          reasoning: `${meta.reasoning}${r.status === "controls" ? ` (via ${r.matches[0]?.via?.toLowerCase()} ${r.address})` : ""}`,
        });
      }
      r.added = true;
    } catch (e) { r.error = e instanceof Error ? e.message : "Failed"; }
  }
  return rows;
}
