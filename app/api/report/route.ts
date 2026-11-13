// GET /api/report[?asset=rsETH][&kind=loops][&download=1]
//   kind=offboarding (default): the monthly progress report, all assets or one.
//   kind=loops: the loop positions report, all assets or one.

import { ASSETS } from "@/config/assets";
import { buildLoopsReport, buildReport } from "@/lib/report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const download = q.get("download") === "1";
  const kind = q.get("kind") === "loops" ? "loops" : "offboarding";
  const raw = q.get("asset");
  const asset = raw ? ASSETS.find((a) => a.symbol.toLowerCase() === raw.toLowerCase())?.symbol : undefined;
  if (raw && !asset) return Response.json({ error: `Unknown asset ${raw}` }, { status: 400 });
  try {
    const r = kind === "loops" ? await buildLoopsReport(asset) : await buildReport(asset);
    if (download) {
      const date = r.generatedAt.slice(0, 10);
      const name = `${asset ?? "all-assets"}-${kind === "loops" ? "loop-positions" : "offboarding"}-${date}.md`;
      return new Response(r.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
    }
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
