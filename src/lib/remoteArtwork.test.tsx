import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_ARTWORK_BASE, setRemoteArtworkLoader, setRemoteArtworkScope, useArtworkUrl } from "./remoteArtwork";

const image = (path: string) => `${REMOTE_ARTWORK_BASE}/${path}`;
const blob = () => new Blob(["cover"], { type: "image/jpeg" });
let sequence = 0;
let testScope = 0;
beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:cover-${++sequence}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  setRemoteArtworkScope(`test-${++testScope}`);
  vi.mocked(URL.revokeObjectURL).mockClear();
});
afterEach(() => {
  cleanup();
  setRemoteArtworkLoader(undefined);
  vi.useRealTimers();
});

describe("remote artwork lifecycle", () => {
  it("keeps the current cover during a disconnect and same-account reconnect", async () => {
    const load = vi.fn(async () => blob());
    setRemoteArtworkLoader(load);
    const { result } = renderHook(() => useArtworkUrl(image("current")));
    await waitFor(() => expect(result.current).toMatch(/^blob:/));
    const cover = result.current;
    act(() => setRemoteArtworkLoader(undefined));
    expect(result.current).toBe(cover);
    act(() => setRemoteArtworkLoader(vi.fn(async () => blob())));
    await act(async () => {});
    expect(result.current).toBe(cover);
    expect(load).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("clears covers when the server or account changes", async () => {
    setRemoteArtworkLoader(async () => blob());
    const { result } = renderHook(() => useArtworkUrl(image("same-path")));
    await waitFor(() => expect(result.current).toMatch(/^blob:/));
    const cover = result.current;
    act(() => setRemoteArtworkScope("another-account"));
    expect(result.current).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(cover);
    act(() => setRemoteArtworkLoader(async () => blob()));
    await waitFor(() => expect(result.current).not.toBe(""));
    expect(result.current).not.toBe(cover);
  });

  it("never displays the previous track's cover for a new image path", async () => {
    setRemoteArtworkLoader(async () => blob());
    const { result, rerender } = renderHook(({ path }) => useArtworkUrl(image(path)), { initialProps: { path: "first" } });
    await waitFor(() => expect(result.current).not.toBe(""));
    const cover = result.current;
    rerender({ path: "second" });
    expect(result.current).toBe("");
    await waitFor(() => expect(result.current).not.toBe(""));
    expect(result.current).not.toBe(cover);
  });

  it("ignores an old transport's late image without deleting its replacement", async () => {
    let finish!: (value: Blob) => void;
    setRemoteArtworkLoader(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useArtworkUrl(image("current")));
    await act(async () => {});
    const replacement = vi.fn(async () => blob());
    act(() => setRemoteArtworkLoader(replacement));
    await waitFor(() => expect(result.current).not.toBe(""));
    const cover = result.current;
    await act(async () => { finish(blob()); });
    const second = renderHook(() => useArtworkUrl(image("current")));
    await waitFor(() => expect(second.result.current).toBe(cover));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("retries temporary download failures without requiring a reconnect", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(blob());
    setRemoteArtworkLoader(load);
    const { result } = renderHook(() => useArtworkUrl(image("retry")));
    await act(async () => {});
    expect(result.current).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current).toMatch(/^blob:/);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds retries and cancels them when a view unmounts", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new Error("unavailable"));
    setRemoteArtworkLoader(load);
    const { unmount } = renderHook(() => useArtworkUrl(image("missing")));
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(load).toHaveBeenCalledTimes(4);
    const next = renderHook(() => useArtworkUrl(image("other")));
    await act(async () => {});
    const count = load.mock.calls.length;
    next.unmount();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(load).toHaveBeenCalledTimes(count);
  });

  it("shares downloads and never evicts covers that are still displayed", async () => {
    const load = vi.fn(async () => blob());
    setRemoteArtworkLoader(load);
    const current = renderHook(() => useArtworkUrl(image("current")));
    const ambient = renderHook(() => useArtworkUrl(image("current")));
    await waitFor(() => expect(current.result.current).not.toBe(""));
    expect(ambient.result.current).toBe(current.result.current);
    expect(load).toHaveBeenCalledOnce();
    const cover = current.result.current;
    const browsing = renderHook(({ path }) => useArtworkUrl(image(path)), { initialProps: { path: "browse-0" } });
    for (let i = 0; i < 90; i++) {
      browsing.rerender({ path: `browse-${i}` });
      await act(async () => {});
    }
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(cover);
    expect(current.result.current).toBe(cover);
  });
});
