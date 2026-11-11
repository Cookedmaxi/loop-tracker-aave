// Shared storage for what people add on the site (community tags).
// Production: Upstash Redis over REST — add it from the Vercel Marketplace, which sets
// KV_REST_API_URL / KV_REST_API_TOKEN (or set UPSTASH_REDIS_REST_URL / _TOKEN yourself).
// Local development without Redis: a JSON file in .data/ (not shared, not on Vercel).

import { promises as fs } from "node:fs";
import path from "node:path";

const URL_ = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

export const storageKind = () => (URL_ && TOKEN ? "redis" : process.env.NODE_ENV === "production" ? "none" : "file");

async function redis(cmd: (string | number)[]): Promise<any> {
  const res = await fetch(URL_ as string, {
    method: "POST", cache: "no-store",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Storage error: ${body.error ?? res.status}`);
  return body.result;
}

const FILE = path.join(process.cwd(), ".data", "store.json");
async function readFile(): Promise<Record<string, Record<string, string>>> {
  try { return JSON.parse(await fs.readFile(FILE, "utf8")); } catch { return {}; }
}
async function writeFile(data: Record<string, Record<string, string>>) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 1));
}

function unavailable(): never {
  throw new Error("Shared storage is not set up. Add Upstash Redis in Vercel (Storage → Marketplace → Upstash) and redeploy.");
}

/** All values of a hash. */
export async function hvals(key: string): Promise<string[]> {
  const kind = storageKind();
  if (kind === "redis") return (await redis(["HVALS", key])) ?? [];
  if (kind === "file") return Object.values((await readFile())[key] ?? {});
  return unavailable();
}

export async function hset(key: string, field: string, value: string): Promise<void> {
  const kind = storageKind();
  if (kind === "redis") { await redis(["HSET", key, field, value]); return; }
  if (kind === "file") { const d = await readFile(); (d[key] ??= {})[field] = value; await writeFile(d); return; }
  unavailable();
}

export async function hget(key: string, field: string): Promise<string | null> {
  const kind = storageKind();
  if (kind === "redis") return (await redis(["HGET", key, field])) ?? null;
  if (kind === "file") return (await readFile())[key]?.[field] ?? null;
  return unavailable();
}

export async function hdel(key: string, field: string): Promise<void> {
  const kind = storageKind();
  if (kind === "redis") { await redis(["HDEL", key, field]); return; }
  if (kind === "file") { const d = await readFile(); delete d[key]?.[field]; await writeFile(d); return; }
  unavailable();
}

/** All fields of a hash. */
export async function hkeys(key: string): Promise<string[]> {
  const kind = storageKind();
  if (kind === "redis") return (await redis(["HKEYS", key])) ?? [];
  if (kind === "file") return Object.keys((await readFile())[key] ?? {});
  return unavailable();
}
