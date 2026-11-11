// GET /api/registry — the team's entities and tagged addresses (edited in /data).
import entities from "@/data/entities.json";
import { allTags } from "@/lib/tags";

export function GET() {
  return Response.json({ entities, tags: allTags });
}
