// Community tags: anyone with access to the site can link a holder to an entity,
// say why and add links. Stored in shared storage, visible to everyone.

import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { hdel, hget, hset, hvals } from "./store";
import type { CommunityTag } from "./types";

const KEY = "community-tags";
const CONFIDENCE = ["Confirmed", "Probable", "Possible"] as const;

export async function listCommunityTags(): Promise<CommunityTag[]> {
  const rows = await hvals(KEY);
  return rows.map((r) => JSON.parse(r) as CommunityTag).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** Checks and stores a new tag. Throws a message meant for the person filling the form. */
export async function addCommunityTag(input: any): Promise<CommunityTag> {
  const address = clean(input?.address, 42);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Enter a full wallet address (0x followed by 40 characters).");
  const entity = clean(input?.entity, 60);
  if (!entity) throw new Error("Name the entity this wallet belongs to.");
  const author = clean(input?.author, 40);
  if (!author) throw new Error("Add your name so others know who tagged it.");
  const reasoning = typeof input?.reasoning === "string" ? input.reasoning.trim().slice(0, 1500) : "";
  if (reasoning.length < 10) throw new Error("Explain in a sentence or two why you think so.");
  const links = (Array.isArray(input?.links) ? input.links : String(input?.links ?? "").split(/\s+/))
    .map((l: unknown) => clean(l, 300)).filter(Boolean).slice(0, 8);
  for (const l of links) if (!/^https?:\/\/[^\s]+$/i.test(l)) throw new Error(`This link is not a web address: ${l}`);
  const confidence = CONFIDENCE.includes(input?.confidence) ? input.confidence : "Possible";
  const tag: CommunityTag = {
    id: randomUUID(), address: getAddress(address.toLowerCase()), entity, label: clean(input?.label, 60) || null,
    confidence, reasoning, links, author, createdAt: new Date().toISOString(),
  };
  await hset(KEY, tag.id, JSON.stringify(tag));
  return tag;
}

/** Only the person who added a tag (same name) can remove it. */
export async function removeCommunityTag(id: string, author: string): Promise<void> {
  const raw = await hget(KEY, id);
  if (!raw) throw new Error("This tag no longer exists.");
  const tag = JSON.parse(raw) as CommunityTag;
  if (tag.author.toLowerCase() !== clean(author, 40).toLowerCase()) throw new Error(`Only ${tag.author} can remove this tag.`);
  await hdel(KEY, id);
}
