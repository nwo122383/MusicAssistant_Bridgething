import type { MediaItem } from "../types";
import type { MassClient } from "./MassClient";

export type LibraryKind = "recent" | "playlists" | "albums" | "artists" | "radio" | "ai_radio";
export const LIBRARY_PAGE_SIZE = 24;
export type LibraryPage = { items: MediaItem[]; hasMore: boolean; updatedAt: number };
const commands = { playlists: "music/playlists/library_items", albums: "music/albums/library_items", artists: "music/artists/library_items", radio: "music/radios/library_items" };

export async function fetchLibraryPage(client: Pick<MassClient, "command">, kind: LibraryKind, query: string, offset: number): Promise<Omit<LibraryPage, "updatedAt">> {
  let result: unknown;
  if (kind === "ai_radio") {
    const shows = await client.command<Array<{ id: string; name: string }>>("ai_radio/stations/list");
    result = shows.filter(show => show.name.toLowerCase().includes(query.toLowerCase())).map((show): MediaItem => ({ uri: `ai_radio://show/${encodeURIComponent(show.id)}`, item_id: show.id, provider: "ai_radio", name: show.name, media_type: "ai_radio" }));
  } else if (query) {
    const search = await client.command<Record<string, MediaItem[]>>("music/search", { search_query: query, limit: 50 });
    result = Object.values(search).flat();
  } else if (kind === "recent") {
    result = await client.command<MediaItem[]>("music/recently_played_items", { limit: 16 });
  } else {
    result = await client.command<MediaItem[]>(commands[kind], { limit: LIBRARY_PAGE_SIZE, offset, favorite: null });
  }
  const items = Array.isArray(result) ? result as MediaItem[] : [];
  return { items, hasMore: !query && kind !== "recent" && kind !== "ai_radio" && items.length === LIBRARY_PAGE_SIZE };
}

export class LibraryCache {
  private scope = "";
  private generation = 0;
  private entries = new Map<string, LibraryPage>();
  private pending = new Map<string, Promise<LibraryPage>>();

  setScope(scope: string): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.clear();
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
  }

  read(key: string): LibraryPage | undefined { return this.entries.get(key); }

  load(key: string, loader: (offset: number) => Promise<Omit<LibraryPage, "updatedAt">>, append = false): Promise<LibraryPage> {
    const baseline = this.entries.get(key);
    const offset = append ? baseline?.items.length || 0 : 0;
    const pendingKey = JSON.stringify([key, offset]);
    const existing = this.pending.get(pendingKey);
    if (existing) return existing;
    const epoch = this.generation;
    const promise = Promise.resolve().then(() => loader(offset)).then(page => {
      if (epoch !== this.generation) throw new Error("Library connection changed");
      const current = this.entries.get(key);
      if (append && current !== baseline && current) return current;
      const items = append && baseline ? [...baseline.items, ...page.items] : page.items;
      const seen = new Set<string>();
      const result = { items: items.filter(item => { if (seen.has(item.uri)) return false; seen.add(item.uri); return true; }), hasMore: page.hasMore, updatedAt: Date.now() };
      this.entries.delete(key);
      this.entries.set(key, result);
      if (this.entries.size > 20) this.entries.delete(this.entries.keys().next().value!);
      return result;
    }).finally(() => { if (this.pending.get(pendingKey) === promise) this.pending.delete(pendingKey); });
    this.pending.set(pendingKey, promise);
    return promise;
  }
}

export function libraryKey(kind: LibraryKind, query = ""): string { return JSON.stringify([kind, query.trim()]); }
