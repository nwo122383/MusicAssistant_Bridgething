import { useEffect, useState } from "react";

export const REMOTE_ARTWORK_BASE = "https://ma.webrtc.invalid";
type Loader = (path: string) => Promise<Blob>;
let loader: Loader | undefined;
let revision = 0;
let scope = "";
let scopeRevision = 0;
const listeners = new Set<() => void>();
type Entry = { url: string; promise?: Promise<string> };
const cache = new Map<string, Entry>();
const users = new Map<string, number>();
const jobs: Array<() => void> = [];
let inFlight = 0;

function drain(): void {
  while (inFlight < 3 && jobs.length) jobs.shift()!();
}

function scheduleLoad(path: string, currentRevision: number, currentLoader: Loader): Promise<Blob> {
  return new Promise((resolve, reject) => {
    jobs.push(() => {
      inFlight += 1;
      void Promise.resolve().then(() => {
        if (revision !== currentRevision) throw new Error("Artwork connection replaced");
        return currentLoader(path);
      }).then(resolve, reject).finally(() => { inFlight -= 1; drain(); });
    });
    drain();
  });
}

export function setRemoteArtworkScope(next: string): void {
  if (scope === next) return;
  scope = next;
  scopeRevision += 1;
  loader = undefined;
  cache.forEach(entry => { if (entry.url) URL.revokeObjectURL(entry.url); });
  cache.clear();
  revision += 1;
  listeners.forEach(listener => listener());
}

export function setRemoteArtworkLoader(next: Loader | undefined): void {
  loader = next;
  revision += 1;
  // A transport is replaceable; downloaded images belong to the server/account.
  cache.forEach((entry, path) => { if (!entry.url) cache.delete(path); });
  listeners.forEach(listener => listener());
}

function trimCache(): void {
  for (const [path, entry] of cache) {
    if (cache.size <= 80) break;
    if (users.has(path)) continue;
    cache.delete(path);
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

function loadRemoteImage(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached) {
    cache.delete(path);
    cache.set(path, cached);
    return cached.promise ?? Promise.resolve(cached.url);
  }
  if (!loader) return Promise.resolve("");
  const currentRevision = revision;
  const entry: Entry = { url: "" };
  cache.set(path, entry);
  entry.promise = scheduleLoad(path, currentRevision, loader).then(blob => {
    if (currentRevision !== revision || cache.get(path) !== entry) return "";
    const url = URL.createObjectURL(blob);
    entry.url = url;
    entry.promise = undefined;
    return url;
  }).catch(() => {
    if (cache.get(path) === entry) cache.delete(path);
    return "";
  });
  trimCache();
  return entry.promise;
}

export function useArtworkUrl(url: string): string {
  const [epoch, setEpoch] = useState(revision);
  const currentScope = scopeRevision;
  const [resolved, setResolved] = useState({ source: "", url: "", scope: -1 });
  const remote = url.startsWith(`${REMOTE_ARTWORK_BASE}/`);
  useEffect(() => {
    const changed = () => setEpoch(revision);
    listeners.add(changed);
    changed();
    return () => { listeners.delete(changed); };
  }, []);
  useEffect(() => {
    if (!remote) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const path = url.slice(REMOTE_ARTWORK_BASE.length);
    users.set(path, (users.get(path) ?? 0) + 1);
    const load = async () => {
      const result = await loadRemoteImage(path);
      if (!active) return;
      if (result) setResolved({ source: url, url: result, scope: currentScope });
      else if (loader && attempts < 3) timer = setTimeout(() => { void load(); }, 2000 * 2 ** attempts++);
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      const remaining = (users.get(path) ?? 1) - 1;
      if (remaining) users.set(path, remaining);
      else users.delete(path);
      trimCache();
    };
  }, [url, remote, epoch, currentScope]);
  return remote ? resolved.source === url && resolved.scope === currentScope ? resolved.url : "" : url;
}
