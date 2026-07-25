import { describe, expect, it } from "vitest";
import { imageUrl, itemImage } from "./images";
import type { MediaItem, QueueItem } from "../types";

describe("Music Assistant artwork helpers", () => {
  it("finds metadata artwork on media items", () => {
    const item = {
      uri: "library://track/1",
      item_id: "1",
      provider: "library",
      name: "Track",
      media_type: "track",
      metadata: { images: [{ path: "cover.jpg", provider: "library" }] },
    } satisfies MediaItem;

    expect(itemImage(item)?.path).toBe("cover.jpg");
  });

  it("finds artwork nested in queue media", () => {
    const item = {
      queue_item_id: "queue-1",
      name: "Track",
      media_item: {
        uri: "library://track/1",
        item_id: "1",
        provider: "library",
        name: "Track",
        media_type: "track",
        image: { path: "nested.jpg", provider: "library" },
      },
    } satisfies QueueItem;

    expect(itemImage(item)?.path).toBe("nested.jpg");
  });

  it("builds an encoded image proxy URL", () => {
    expect(imageUrl("http://ma.local:8095/", { path: "folder/cover art.jpg", provider: "filesystem" }, 256))
      .toBe("http://ma.local:8095/imageproxy?path=folder%252Fcover%2520art.jpg&provider=filesystem&size=256");
  });

  it("uses opaque proxy IDs and supported thumbnail sizes", () => {
    expect(imageUrl("http://ma.local:8095", {
      path: "track.mp3",
      provider: "filesystem",
      proxy_id: "abc123",
    }, 128)).toBe("http://ma.local:8095/imageproxy/abc123?size=160");
  });

  it("handles proxy_id only images with no path", () => {
    expect(imageUrl("http://ma.local:8095", {
      provider: "spotify",
      proxy_id: "abc123",
    } as any, 128)).toBe("http://ma.local:8095/imageproxy/abc123?size=160");
  });

  it("caps image proxy size over the local phone relay", () => {
    expect(imageUrl("http://127.0.0.1:4173/mass", {
      provider: "spotify",
      proxy_id: "abc123",
    } as any, 512)).toBe("http://127.0.0.1:4173/mass/imageproxy/abc123?size=160");
  });

  it("returns direct URL when image.url is present", () => {
    expect(imageUrl("http://ma.local:8095", {
      provider: "spotify",
      url: "http://external-cdn.com/cover.jpg",
    } as any, 128)).toBe("http://external-cdn.com/cover.jpg");
  });

  it("normalizes direct Music Assistant imageproxy URLs", () => {
    expect(imageUrl("http://ha.local", "http://ma.local:8095/imageproxy/abc123?size=0", 256))
      .toBe("http://ma.local:8095/imageproxy/abc123?size=256&fmt=jpg");
  });
});
