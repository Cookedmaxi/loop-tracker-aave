// GET /api/tx?asset=rsETH&scope=market      every recent move on the market
// GET /api/tx?asset=rsETH&scope=holders     recent transfers of all tracked holders
// GET /api/tx?asset=rsETH&address=0x…       recent transfers of one wallet
import type { Address } from "@/config/assets";
import { findAsset, getHoldersTx, getMarketTx, getWalletTx } from "@/lib/loops";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const asset = findAsset(q.get("asset"));
  if (!asset) return Response.json({ error: "Unknown asset" }, { status: 400 });
  const fresh = q.get("fresh") === "1";
  const address = q.get("address");
  try {
    if (address) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return Response.json({ error: "Invalid address" }, { status: 400 });
      return Response.json({ transfers: await getWalletTx(asset, address as Address, fresh) });
    }
    const transfers = q.get("scope") === "holders" ? await getHoldersTx(asset, fresh) : await getMarketTx(asset, fresh);
    return Response.json({ transfers });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not load transactions" }, { status: 502 });
  }
}
