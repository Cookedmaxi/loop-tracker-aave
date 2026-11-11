import { ASSETS } from "@/config/assets";
import { getRisk } from "@/lib/risk";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const asset = ASSETS.find((a) => a.symbol === q.get("asset")) ?? ASSETS[0];
  try {
    return Response.json({ risk: await getRisk(asset, q.get("fresh") === "1") });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
