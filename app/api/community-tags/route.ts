// GET    /api/community-tags            every community tag, newest first
// POST   /api/community-tags            add one: { address, entity, label?, confidence, reasoning, links[], author }
// DELETE /api/community-tags?id=…&author=…  remove your own
import { addCommunityTag, listCommunityTags, removeCommunityTag } from "@/lib/community";

export const dynamic = "force-dynamic";

const fail = (err: unknown, status: number) => Response.json({ error: err instanceof Error ? err.message : "Something went wrong" }, { status });

export async function GET() {
  try { return Response.json({ tags: await listCommunityTags() }); } catch (err) { return fail(err, 503); }
}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  try { return Response.json({ tag: await addCommunityTag(input) }, { status: 201 }); }
  catch (err) { return fail(err, err instanceof Error && err.message.startsWith("Storage") ? 503 : 400); }
}

export async function DELETE(request: Request) {
  const q = new URL(request.url).searchParams;
  try { await removeCommunityTag(q.get("id") ?? "", q.get("author") ?? ""); return Response.json({ ok: true }); }
  catch (err) { return fail(err, 400); }
}
