// POST /api/community-tags/batch
//   { text, entity?, apply?: false }                   → each address checked against every tracked asset
//   { text, entity?, apply: true, include[], author, reasoning, confidence, links } → also tags the ones that fit
import { applyBatch, checkBatch, type BatchRow } from "@/lib/batch-tags";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b.text !== "string" || !b.text.trim()) return Response.json({ error: "Paste at least one address." }, { status: 400 });
  try {
    const rows = await checkBatch(b.text, typeof b.entity === "string" ? b.entity : "");
    if (!b.apply) return Response.json({ rows });
    const author = String(b.author ?? "").trim(), reasoning = String(b.reasoning ?? "").trim();
    if (!author) return Response.json({ error: "Add your name so others know who tagged them." }, { status: 400 });
    if (reasoning.length < 10) return Response.json({ error: "Say in a sentence where this list comes from." }, { status: 400 });
    const include = (Array.isArray(b.include) ? b.include : ["loop", "borrower"]) as BatchRow["status"][];
    return Response.json({ rows: await applyBatch(rows, include, { author, reasoning, confidence: b.confidence ?? "Probable", links: b.links ?? "" }) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
