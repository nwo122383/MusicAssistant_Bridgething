import type { MassImage, MediaItem, QueueItem } from "../types";

function isValidImage(img?: any): boolean {
  if (!img) return false;
  if (typeof img === "string") return img.trim().length > 0;
  return !!img.path || !!img.proxy_id || !!img.url;
}

export function itemImage(item?: any): any {
  if (!item) return undefined;
  
  const checkImage = (img?: any) => isValidImage(img) ? img : undefined;
  
  if ("queue_item_id" in item) {
    const media = item.media_item;
    return (
      checkImage(media?.metadata?.images?.[0]) ??
      checkImage(media?.image) ??
      checkImage(media?.images?.[0]) ??
      checkImage(item.image) ??
      checkImage(item.images?.[0]) ??
      checkImage(media?.album?.metadata?.images?.[0]) ??
      checkImage(media?.album?.image) ??
      checkImage(media?.album?.images?.[0])
    );
  }
  return (
    checkImage(item.album?.metadata?.images?.[0]) ??
    checkImage(item.album?.image) ??
    checkImage(item.album?.images?.[0]) ??
    checkImage(item.metadata?.images?.[0]) ??
    checkImage(item.image) ??
    checkImage(item.images?.[0])
  );
}

export function imageUrl(serverUrl: string, image?: MassImage | string, size = 512, cacheKey?: string): string {
  if (!image) return "";
  const base = serverUrl.replace(/\/$/, "");
  const localPhoneRelay = base.includes("127.0.0.1:4173/mass") || base.includes("localhost:4173/mass");
  const allowedSizes = [80, 160, 256, 512, 1024];
  let normalizedSize = allowedSizes.find((allowed) => allowed >= size) || 1024;
  if (localPhoneRelay) {
    // The phone relay currently carries WebRTC HTTP-proxy responses as a
    // single hex-encoded data-channel message. Keep image responses small
    // enough to avoid closing the data channel on Car Thing.
    normalizedSize = Math.min(normalizedSize, 160);
  }
  if (typeof image === "string") return normalizeStringImageUrl(image, normalizedSize, cacheKey);
  if (image.proxy_id) {
    return appendCacheKey(`${base}/imageproxy/${encodeURIComponent(image.proxy_id)}?size=${normalizedSize}`, cacheKey);
  }
  if (image.path) {
    return appendCacheKey(`${base}/imageproxy?path=${encodeURIComponent(encodeURIComponent(image.path))}&provider=${encodeURIComponent(image.provider)}&size=${normalizedSize}`, cacheKey);
  }
  if (image.url) return appendCacheKey(image.url, cacheKey);
  return "";
}

function normalizeStringImageUrl(image: string, size: number, cacheKey?: string): string {
  try {
    const url = new URL(image);
    if (url.pathname.includes("/imageproxy")) {
      url.searchParams.set("size", String(size));
      if (!url.searchParams.has("fmt")) url.searchParams.set("fmt", "jpg");
    }
    if (cacheKey) url.searchParams.set("v", cacheKey);
    return url.toString();
  } catch {
    return image;
  }
}

function appendCacheKey(url: string, cacheKey?: string): string {
  if (!cacheKey) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${encodeURIComponent(cacheKey)}`;
}
