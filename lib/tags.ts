import tags from "@/data/tags.json";
import notes from "@/data/notes.json";
import type { Tag } from "./types";

// A rule matches a full address, or a short form "0x40E9…AbA8" (start and end of the address).
function matches(rule: string, address: string): boolean {
  const a = address.toLowerCase();
  const r = rule.toLowerCase().trim();
  if (r.includes("…") || r.includes("...")) {
    const [head, tail] = r.split(/…|\.\.\./);
    return a.startsWith(head) && a.endsWith(tail);
  }
  return a === r;
}

export function tagOf(address: string | null | undefined): Tag | null {
  if (!address) return null;
  const t = tags.find((x) => matches(x.match, address));
  return t ? { label: t.label, entity: t.entity, kind: t.kind } : null;
}

export function notesOf(address: string) {
  return notes.filter((n) => matches(n.match, address)).map(({ match: _m, ...rest }) => rest);
}

export const allTags = tags;
