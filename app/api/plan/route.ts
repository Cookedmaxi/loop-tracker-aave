import { ASSETS } from "@/config/assets";
import { getPlan } from "@/lib/plan";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const asset = ASSETS.find((a) => a.symbol === q.get("asset")) ?? ASSETS[0];
  try {
    const plan = await getPlan(asset, q.get("fresh") === "1");
    return Response.json({ plan });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
