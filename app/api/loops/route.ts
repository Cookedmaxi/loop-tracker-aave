// GET /api/loops?asset=rsETH[&fresh=1] — market figures and tracked positions, read on-chain.
import { findAsset, getLoops } from "@/lib/loops";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const asset = findAsset(q.get("asset"));
  if (!asset) return Response.json({ error: "Unknown asset" }, { status: 400 });
  try {
    return Response.json(await getLoops(asset, q.get("fresh") === "1"));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not read the chain" }, { status: 502 });
  }
}
