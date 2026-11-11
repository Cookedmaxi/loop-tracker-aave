import { buildReport } from "@/lib/report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const download = new URL(request.url).searchParams.get("download") === "1";
  try {
    const r = await buildReport();
    if (download) {
      return new Response(r.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="aave-core-repositioning-${r.month.toLowerCase().replace(/\s+/g, "-")}.md"` } });
    }
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
