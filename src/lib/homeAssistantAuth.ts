import { sha256 } from "@noble/hashes/sha2.js";

const PREFIX = "ha-oauth-v1:";
export const HA_CLIENT_ID = "https://bridgething.com/";
export const HA_REDIRECT_URI = "https://bridgething.com/oauth/callback";
const HA_NATIVE_CALLBACK = "bridgething://oauth/callback";

export type HaSession = { origin: string; accessToken: string; refreshToken: string; expiresAt: number };
export type AuthFetch = (url: string, init: RequestInit) => Promise<Response>;

export function haOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Enter a Home Assistant HTTPS URL");
  return url.origin;
}

export function decodeHaSession(value: string, serverUrl: string): HaSession | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  let session: HaSession;
  try { session = JSON.parse(value.slice(PREFIX.length)); }
  catch { throw new Error("Home Assistant sign-in is invalid. Sign in again."); }
  if (!session || typeof session.accessToken !== "string" || !session.accessToken ||
    typeof session.refreshToken !== "string" || !session.refreshToken || !Number.isFinite(session.expiresAt)) {
    throw new Error("Home Assistant sign-in is invalid. Sign in again.");
  }
  if (session.origin !== haOrigin(serverUrl)) throw new Error("Sign in to Home Assistant again for this server URL");
  return session;
}

export function encodeHaSession(session: HaSession): string {
  const value = PREFIX + JSON.stringify(session);
  if (value.length > 2048) throw new Error("Home Assistant sign-in exceeds the credential storage limit");
  return value;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function tokenRequest(origin: string, body: URLSearchParams, fetcher: AuthFetch, previous?: HaSession): Promise<HaSession> {
  const response = await fetcher(`${origin}/auth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), redirect: "error",
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new HaSignInRequired("Home Assistant sign-in expired or was rejected. Sign in again.");
    }
    throw new Error(`Home Assistant sign-in request failed (${response.status})`);
  }
  const result = await response.json();
  if (!result || typeof result.access_token !== "string" || !result.access_token ||
    !Number.isFinite(result.expires_in) || result.expires_in <= 0 ||
    !Number.isFinite(Date.now() + result.expires_in * 1000) ||
    (result.token_type && (typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer"))) {
    throw new Error("Home Assistant returned an invalid sign-in response");
  }
  const refreshToken = result.refresh_token ?? previous?.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken) throw new Error("Home Assistant did not return a renewable sign-in");
  // HA refresh grants keep the existing refresh token. Do not silently lose a rotated credential.
  if (previous && refreshToken !== previous.refreshToken) throw new HaSignInRequired("Home Assistant credentials changed. Sign in again.");
  return { origin, accessToken: result.access_token, refreshToken, expiresAt: Date.now() + result.expires_in * 1000 };
}

export class HaSignInRequired extends Error {}

export async function refreshHaSession(session: HaSession, fetcher: AuthFetch): Promise<HaSession> {
  return tokenRequest(session.origin, new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: HA_CLIENT_ID }), fetcher, session);
}

export async function signInToHomeAssistant(serverUrl: string, host: {
  authorize: (url: URL) => Promise<URL>; fetch: AuthFetch;
}, isCurrent: () => boolean = () => true): Promise<HaSession> {
  const origin = haOrigin(serverUrl);
  const assertCurrent = () => { if (!isCurrent()) throw new Error("Sign-in cancelled because the selected device or server changed"); };
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure randomness is unavailable. Update BridgeThing before signing in.");
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  // Phone settings have a null origin: getRandomValues works, but SubtleCrypto may not.
  const challenge = base64url(sha256(new TextEncoder().encode(verifier)));
  assertCurrent();
  const authorize = new URL(`${origin}/auth/authorize`);
  authorize.search = new URLSearchParams({ client_id: HA_CLIENT_ID, redirect_uri: HA_REDIRECT_URI, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  const callback = await host.authorize(authorize);
  assertCurrent();
  const callbackBase = `${callback.protocol}//${callback.host}${callback.pathname}`;
  if (![HA_REDIRECT_URI, HA_NATIVE_CALLBACK].includes(callbackBase) || callback.username || callback.password || callback.hash ||
    callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== state) {
    throw new Error("Home Assistant sign-in response could not be verified");
  }
  if (callback.searchParams.has("error")) throw new Error("Home Assistant sign-in was not approved");
  const codes = callback.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) throw new Error("Home Assistant did not return a sign-in code");
  const session = await tokenRequest(origin, new URLSearchParams({ grant_type: "authorization_code", code: codes[0], client_id: HA_CLIENT_ID, redirect_uri: HA_REDIRECT_URI, code_verifier: verifier }), host.fetch);
  assertCurrent();
  return session;
}
