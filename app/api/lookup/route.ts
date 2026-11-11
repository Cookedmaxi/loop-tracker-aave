import { lookup } from "@/lib/lookup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address") ?? "";
  try {
    return Response.json(await lookup(address));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 400 });
  }
}
