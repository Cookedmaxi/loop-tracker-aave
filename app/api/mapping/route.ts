import { ASSETS } from "@/config/assets";
import { getMapping } from "@/lib/mapping";
import { mappingMarkdown } from "@/lib/mapping-md";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const asset = ASSETS.find((a) => a.symbol === q.get("asset")) ?? ASSETS[0];
  try {
    const m = await getMapping(asset, q.get("fresh") === "1");
    if (q.get("format") === "md") {
      return new Response(mappingMarkdown(m), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="mapping-${asset.symbol}-aave-v3-core.md"` } });
    }
    return Response.json({ mapping: m, markdown: mappingMarkdown(m) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
