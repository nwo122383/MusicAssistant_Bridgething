import { useEffect, useState } from "react";

export const REMOTE_ARTWORK_BASE = "https://ma.webrtc.invalid";
type Loader = (path: string) => Promise<Blob>;
let loader: Loader | undefined;
let revision = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, Promise<string>>();
const objectUrls = new Set<string>();
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

export function setRemoteArtworkLoader(next: Loader | undefined): void {
  loader = next;
  revision += 1;
  cache.clear();
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls.clear();
  listeners.forEach(listener => listener());
}

function loadRemoteImage(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached) return cached;
  if (!loader) return Promise.resolve("");
  const currentRevision = revision;
  const promise = scheduleLoad(path, currentRevision, loader).then(blob => {
    if (currentRevision !== revision) return "";
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    return url;
  }).catch(() => {
    if (currentRevision === revision) cache.delete(path);
    return "";
  });
  cache.set(path, promise);
  // Limit artwork retained while browsing a large library on the Car Thing.
  if (cache.size > 80) {
    const oldest = cache.keys().next().value!;
    const entry = cache.get(oldest)!;
    cache.delete(oldest);
    void entry.then(url => { if (url) { URL.revokeObjectURL(url); objectUrls.delete(url); } });
  }
  return promise;
}

export function useArtworkUrl(url: string): string {
  const [epoch, setEpoch] = useState(revision);
  const [resolved, setResolved] = useState({ source: "", url: "", epoch: -1 });
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
    void loadRemoteImage(url.slice(REMOTE_ARTWORK_BASE.length)).then(result => {
      if (active) setResolved({ source: url, url: result, epoch });
    });
    return () => { active = false; };
  }, [url, remote, epoch]);
  return remote ? resolved.source === url && resolved.epoch === epoch ? resolved.url : "" : url;
}
