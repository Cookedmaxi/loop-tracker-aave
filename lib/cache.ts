import { CACHE_SECONDS } from "@/config/assets";

// Small in-memory cache so that several clicks in a row read the chain once.
const store = new Map<string, { at: number; value: Promise<unknown> }>();

export function cached<T>(key: string, fn: () => Promise<T>, fresh = false): Promise<T> {
  const hit = store.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_SECONDS * 1000) return hit.value as Promise<T>;
  const value = fn().catch((err) => { store.delete(key); throw err; });
  store.set(key, { at: Date.now(), value });
  return value;
}
