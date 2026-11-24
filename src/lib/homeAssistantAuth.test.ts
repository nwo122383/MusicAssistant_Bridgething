import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHaSession, encodeHaSession, HA_CLIENT_ID, HA_REDIRECT_URI, refreshHaSession, signInToHomeAssistant } from "./homeAssistantAuth";

beforeEach(async () => { const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto"); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); });
const origin = "https://ha.example.com";
const session = { origin, accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 1800_000 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup() {
  const fetch = vi.fn(async () => response({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 1800, token_type: "Bearer" }));
  const authorize = vi.fn(async (url: URL) => {
    const callback = new URL(HA_REDIRECT_URI);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", "test-code");
    return callback;
  });
  return { authorize, fetch };
}

describe("Home Assistant browser sign-in", () => {
  it("uses the platform callback, random state and S256 PKCE without collecting a password", async () => {
    const host = setup();
    const result = await signInToHomeAssistant(origin + "/lovelace", host);
    expect(result).toMatchObject({ origin, accessToken: "test-access", refreshToken: "test-refresh" });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    const url = host.authorize.mock.calls[0][0];
    expect(url.origin + url.pathname).toBe(origin + "/auth/authorize");
    expect(url.searchParams.get("client_id")).toBe(HA_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(HA_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const [endpoint, init] = host.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe(origin + "/auth/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("code")).toBe("test-code");
    expect(body.has("password")).toBe(false);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier")!));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(url.searchParams.get("code_challenge"));
    expect(init.redirect).toBe("error");
  });

  it("opens authorization with secure PKCE when the WebView has no SubtleCrypto", async () => {
    const native = crypto;
    vi.stubGlobal("crypto", { getRandomValues: native.getRandomValues.bind(native) });
    const host = setup();
    await signInToHomeAssistant(origin, host);
    expect(host.authorize).toHaveBeenCalledOnce();
    expect(host.authorize.mock.calls[0][0].searchParams.get("code_challenge_method")).toBe("S256");
    const [, init] = host.fetch.mock.calls[0] as unknown as [string, RequestInit];
    const verifier = new URLSearchParams(String(init.body)).get("code_verifier")!;
    const digest = await native.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(host.authorize.mock.calls[0][0].searchParams.get("code_challenge")).toBe(challenge);
  });

  it("accepts BridgeThing's exact native callback while keeping state verification", async () => {
    const host = setup();
    host.authorize.mockImplementation(async url => {
      const callback = new URL("bridgething://oauth/callback");
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "test-code");
      return callback;
    });
    await expect(signInToHomeAssistant(origin, host)).resolves.toMatchObject({ accessToken: "test-access" });
  });

  it.each(["bridgething://other/callback", "bridgething://oauth/wrong", "bridgething://oauth/callback?state=wrong&code=test", "https://bridgething.com.evil.example/oauth/callback"])("rejects an invalid native/browser callback %s", async target => {
    const host = setup();
    host.authorize.mockImplementation(async url => {
      const callback = new URL(target);
      if (!callback.searchParams.has("state")) callback.searchParams.set("state", url.searchParams.get("state")!);
      if (!callback.searchParams.has("code")) callback.searchParams.set("code", "test-code");
      return callback;
    });
    await expect(signInToHomeAssistant(origin, host)).rejects.toThrow(/could not be verified/);
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it("does not fall back to insecure random state or a non-PKCE login", async () => {
    vi.stubGlobal("crypto", {});
    const host = setup();
    await expect(signInToHomeAssistant(origin, host)).rejects.toThrow(/Secure randomness/);
    expect(host.authorize).not.toHaveBeenCalled();
  });

  it.each(["state", "host", "code"])("rejects an invalid callback %s before exchanging credentials", async field => {
    const host = setup();
    host.authorize.mockImplementation(async url => {
      const callback = new URL(field === "host" ? "https://other.example/callback" : HA_REDIRECT_URI);
      callback.searchParams.set("state", field === "state" ? "wrong" : url.searchParams.get("state")!);
      if (field !== "code") callback.searchParams.set("code", "test-code");
      return callback;
    });
    await expect(signInToHomeAssistant(origin, host)).rejects.toThrow();
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it("ignores a callback belonging to a replaced device/context", async () => {
    const host = setup(); let current = true;
    const authorize = host.authorize.getMockImplementation()!;
    host.authorize.mockImplementation(async url => { const callback = await authorize(url); current = false; return callback; });
    await expect(signInToHomeAssistant(origin, host, () => current)).rejects.toThrow(/selected device or server changed/);
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it("keeps the stored sign-in bound to its HA origin", () => {
    expect(decodeHaSession(encodeHaSession(session), origin + "/lovelace")).toEqual(session);
    expect(decodeHaSession("manual-token", origin)).toBeUndefined();
    expect(() => decodeHaSession(encodeHaSession(session), "https://other.example")).toThrow(/this server URL/);
    expect(() => decodeHaSession("ha-oauth-v1:broken", origin)).toThrow(/Sign in again/);
    expect(() => decodeHaSession("ha-oauth-v1:{}", origin)).toThrow(/Sign in again/);
    expect(() => encodeHaSession({ ...session, accessToken: "x".repeat(2048) })).toThrow(/storage limit/);
  });

  it("refreshes the access token without needing the phone settings page open", async () => {
    const fetch = vi.fn(async () => response({ access_token: "fresh-access", expires_in: 1800 }));
    const next = await refreshHaSession(session, fetch);
    expect(next.accessToken).toBe("fresh-access");
    expect(next.refreshToken).toBe(session.refreshToken);
    const body = new URLSearchParams(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("test-refresh");
  });

  it("does not disclose raw error bodies or credentials", async () => {
    const host = setup();
    host.fetch.mockResolvedValue(response({ error: "test-refresh private details" }, 400));
    await expect(signInToHomeAssistant(origin, host)).rejects.toThrow("Home Assistant sign-in expired or was rejected. Sign in again.");
  });

  it.each(["http://ha.example.com", "https://user:password@ha.example.com"])("does not send credentials to an unsafe endpoint %s", async url => {
    const host = setup();
    await expect(signInToHomeAssistant(url, host)).rejects.toThrow(/HTTPS URL/);
    expect(host.authorize).not.toHaveBeenCalled();
  });
});
