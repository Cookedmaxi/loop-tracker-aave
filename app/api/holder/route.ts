// GET /api/holder?address=0x… — what is publicly known about a wallet, plus the team's own notes.
import type { Address } from "@/config/assets";
import { cached } from "@/lib/cache";
import { getAddressInfo } from "@/lib/blockscout";
import { notesOf, tagOf } from "@/lib/tags";
import type { HolderDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return Response.json({ error: "Invalid address" }, { status: 400 });
  const info = await cached(`holder:${address.toLowerCase()}`, () => getAddressInfo(address as Address))
    .catch(() => ({ name: null, ens: null, isContract: false, creator: null, publicTags: [] as string[] }));
  const detail: HolderDetail = { address: address as Address, tag: tagOf(address), ...info, notes: notesOf(address) };
  return Response.json(detail);
}
