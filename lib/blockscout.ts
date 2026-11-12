// Indexer calls (Blockscout REST API v2): what an RPC alone cannot give — the holders
// of a token, transfer history and public labels. Field names have changed between
// Blockscout versions, so both spellings are read.

import { getAddress } from "viem";
import type { Address } from "@/config/assets";

const BASE = process.env.BLOCKSCOUT_URL ?? "https://eth.blockscout.com";
const ZERO = "0x0000000000000000000000000000000000000000";

async function get(path: string): Promise<any> {
  const res = await fetch(`${BASE}/api/v2${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`Blockscout answered ${res.status} for ${path}`);
  return res.json();
}

const hashOf = (a: any): Address | null => (a?.hash ?? a ?? null) as Address | null;

export interface Holder { address: Address; isContract: boolean; name: string | null; ens: string | null; balance: number | null }

/** Top holders of a token, largest first; stops at `limit` or below `minBalance` (in tokens). */
export async function getTopHolders(token: Address, limit: number, minBalance = 0, decimals = 18, keepAtLeast = 0): Promise<Holder[]> {
  const out: Holder[] = [];
  let query = "";
  while (out.length < limit) {
    const page = await get(`/tokens/${token}/holders${query}`);
    for (const it of page.items ?? []) {
      const a = it.address ?? {};
      const raw = (a.hash ?? it.address_hash) as string | undefined;
      if (!raw || raw.toLowerCase() === ZERO) continue;
      const address = getAddress(raw.toLowerCase()); // normalise the checksum
      const balance = it.value != null ? Number(it.value) / 10 ** decimals : null;
      // Sorted largest first: stop below minBalance, once the largest `keepAtLeast` holders are in.
      if (minBalance && balance != null && balance < minBalance && out.length >= keepAtLeast) return out;
      out.push({ address, isContract: Boolean(a.is_contract), name: a.name ?? null, ens: a.ens_domain_name ?? null, balance });
      if (out.length >= limit) break;
    }
    if (!page.next_page_params || !(page.items ?? []).length) break;
    query = "?" + new URLSearchParams(Object.entries(page.next_page_params).map(([k, v]) => [k, String(v)])).toString();
  }
  return out;
}

export async function getHolderCount(token: Address): Promise<number | null> {
  const t = await get(`/tokens/${token}`);
  const n = Number(t.holders_count ?? t.holders ?? NaN);
  return Number.isFinite(n) ? n : null;
}

export interface RawTransfer { txHash: string; timestamp: string; from: Address; to: Address; tokenSymbol: string; tokenAddress: Address; amount: number; logIndex: string }

function toTransfer(it: any): RawTransfer {
  const decimals = Number(it.total?.decimals ?? it.token?.decimals ?? 18);
  return {
    txHash: it.transaction_hash ?? it.tx_hash ?? "",
    timestamp: it.timestamp ?? "",
    from: hashOf(it.from) as Address,
    to: hashOf(it.to) as Address,
    tokenSymbol: it.token?.symbol ?? "",
    tokenAddress: (it.token?.address_hash ?? it.token?.address ?? "") as Address,
    amount: Number(it.total?.value ?? 0) / 10 ** decimals,
    logIndex: String(it.log_index ?? ""),
  };
}

/** Latest transfers of a token across all wallets, newest first. */
export async function getTokenTransfers(token: Address, limit = 50): Promise<RawTransfer[]> {
  const page = await get(`/tokens/${token}/transfers`);
  return (page.items ?? []).slice(0, limit).map(toTransfer);
}

/** Latest ERC-20 transfers of a wallet, newest first. */
export async function getAddressTransfers(address: Address, limit = 50): Promise<RawTransfer[]> {
  const page = await get(`/addresses/${address}/token-transfers?type=ERC-20`);
  return (page.items ?? []).slice(0, limit).map(toTransfer);
}

export async function getAddressInfo(address: Address) {
  const a = await get(`/addresses/${address}`);
  const tags: string[] = [
    ...(a.public_tags ?? []).map((t: any) => t.display_name ?? t.label),
    ...(a.metadata?.tags ?? []).map((t: any) => t.name ?? t.slug),
  ].filter(Boolean);
  return {
    name: (a.name ?? null) as string | null,
    ens: (a.ens_domain_name ?? null) as string | null,
    isContract: Boolean(a.is_contract),
    creator: (a.creator_address_hash ?? null) as Address | null,
    publicTags: Array.from(new Set(tags)),
  };
}

export const isZero = (a: string | null | undefined) => !a || a.toLowerCase() === ZERO;
