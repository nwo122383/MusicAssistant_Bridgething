import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../types";
import { fetchLibraryPage, LibraryCache, libraryKey, LIBRARY_PAGE_SIZE } from "./library";

const item = (id: number): MediaItem => ({ item_id: String(id), name: `Item ${id}`, uri: `library://track/${id}`, provider: "library", media_type: "track" });

describe("library tab cache", () => {
  it("shares in-flight requests and retains completed tabs for instant reads", async () => {
    const cache = new LibraryCache();
    let finish!: (value: { items: MediaItem[]; hasMore: boolean }) => void;
    const loader = vi.fn(() => new Promise<{ items: MediaItem[]; hasMore: boolean }>(resolve => { finish = resolve; }));
    const first = cache.load("albums", loader);
    const second = cache.load("albums", loader);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    finish({ items: [item(1)], hasMore: true });
    expect(await second).toEqual(await first);
    expect(cache.read("albums")?.items).toEqual([item(1)]);
  });

  it("keeps loaded pages when revisiting a tab and appends at the correct offset", async () => {
    const cache = new LibraryCache();
    const loader = vi.fn(async (offset: number) => ({ items: Array.from({ length: 24 }, (_, i) => item(offset + i)), hasMore: true }));
    await cache.load("albums", loader);
    await cache.load("albums", loader, true);
    expect(loader.mock.calls).toEqual([[0], [24]]);
    expect(cache.read("albums")?.items).toHaveLength(48);
    await cache.load("artists", async () => ({ items: [item(50)], hasMore: false }));
    expect(cache.read("albums")?.items).toHaveLength(48);
  });

  it("does not leak cached or delayed results across servers or accounts", async () => {
    const cache = new LibraryCache();
    cache.setScope("server-a");
    let finish!: (value: { items: MediaItem[]; hasMore: boolean }) => void;
    const pending = cache.load("albums", () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    cache.setScope("server-b");
    const rejected = expect(pending).rejects.toThrow(/connection changed/);
    finish({ items: [item(1)], hasMore: false });
    await rejected;
    expect(cache.read("albums")).toBeUndefined();
  });

  it("allows retrying errors and bounds remembered search results", async () => {
    const cache = new LibraryCache();
    await expect(cache.load("radio", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await cache.load("radio", async () => ({ items: [item(1)], hasMore: false }));
    for (let i = 0; i < 25; i++) await cache.load(libraryKey("albums", String(i)), async () => ({ items: [], hasMore: false }));
    expect(cache.read("radio")).toBeUndefined();
    expect(cache.read(libraryKey("albums", "24"))).toBeDefined();
  });

  it("requests small initial pages while preserving full pagination", async () => {
    const command = vi.fn().mockResolvedValue(Array.from({ length: LIBRARY_PAGE_SIZE }, (_, i) => item(i)));
    const page = await fetchLibraryPage({ command }, "playlists", "", 24);
    expect(command).toHaveBeenCalledWith("music/playlists/library_items", { limit: 24, offset: 24, favorite: null });
    expect(page.hasMore).toBe(true);
  });
});
