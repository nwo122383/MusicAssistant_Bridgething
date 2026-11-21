import { settings } from "@bridgething/settings-client/settings";
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { validateConnection, normalizeRemoteId } from "../src/lib/connection";
import { MassClient } from "../src/lib/MassClient";
import { Link, LoaderCircle, LogIn, X } from "lucide-react";

type Values = {
  serverUrl: string;
  remoteId: string;
  token: string;
  transport: "homeassistant" | "bridgething" | "direct" | "webrtc";
  displaySize: "standard" | "large" | "xlarge";
  nowPlayingTextSize: "small" | "medium" | "large" | "xlarge";
  brightnessMode: "auto" | "manual";
  brightnessLevel: number;
};

const defaultValues: Values = {
  serverUrl: "",
  remoteId: "",
  token: "",
  transport: "bridgething",
  displaySize: "standard",
  nowPlayingTextSize: "medium",
  brightnessMode: "auto",
  brightnessLevel: 0.55,
};

function validate(values: Values): string | undefined {
  return validateConnection(values);
}

function urlLabel(transport: Values["transport"]): string {
  if (transport === "homeassistant") return "Home Assistant / Nabu Casa URL";
  if (transport === "bridgething") return "Music Assistant HTTPS URL";
  return "Music Assistant URL";
}

function urlPlaceholder(transport: Values["transport"]): string {
  if (transport === "homeassistant") return "https://home-assistant.example.com";
  if (transport === "bridgething") return "https://music.example.com";
  return "http://music-assistant.local:8095";
}

function tokenLabel(transport: Values["transport"]): string {
  if (transport === "webrtc") return "Music Assistant access token";
  return transport === "homeassistant" ? "Home Assistant long-lived access token" : "Access token";
}

function tokenPlaceholder(transport: Values["transport"]): string {
  return transport === "homeassistant" ? "Required for Home Assistant" : "Optional if login is disabled";
}

function parseDisplaySize(value: string | undefined): Values["displaySize"] {
  return value === "large" || value === "xlarge" ? value : "standard";
}

function parseNowPlayingTextSize(value: string | undefined): Values["nowPlayingTextSize"] {
  return value === "small" || value === "large" || value === "xlarge" ? value : "medium";
}

function parseBrightnessMode(value: string | undefined): Values["brightnessMode"] {
  return value === "manual" ? "manual" : "auto";
}

function parseBrightnessLevel(value: string | undefined): number {
  const level = Number(value);
  if (!Number.isFinite(level)) return defaultValues.brightnessLevel;
  return Math.max(0.05, Math.min(1, level));
}

export function SettingsApp() {
  const [values, setValues] = useState<Values>(defaultValues);
  const [status, setStatus] = useState("Loading settings");
  const [saving, setSaving] = useState(false);
  const [authStage, setAuthStage] = useState<"idle" | "connecting" | "login" | "signingIn">("idle");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const contextRevision = useRef(0);
  const authSession = useRef<{ client: MassClient; revision: number; remoteId: string } | undefined>(undefined);

  const cancelAuth = () => {
    const session = authSession.current;
    authSession.current = undefined;
    session?.client.disconnect();
    setAuthStage("idle");
    setUsername("");
    setPassword("");
  };

  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const load = async () => {
      const request = ++revision;
      contextRevision.current += 1;
      cancelAuth();
      setStatus("Loading settings");
      try {
        const [configEntries, docEntries] = await Promise.all([
          settings.config.list(),
          settings.doc.list(),
        ]);
        const nextConfig = Object.fromEntries(configEntries.map((entry) => [entry.key, entry.value]));
        const nextDocs = Object.fromEntries(docEntries.map((entry) => [entry.key, entry.value]));
        if (!cancelled && request === revision) {
          setValues({
            serverUrl: nextConfig.serverUrl || "",
            remoteId: nextConfig.remoteId || "",
            token: nextConfig.token || "",
            transport:
              nextConfig.transport === "homeassistant" || nextConfig.transport === "direct" || nextConfig.transport === "webrtc"
                ? nextConfig.transport
                : "bridgething",
            displaySize: parseDisplaySize(nextDocs.displaySize ?? nextConfig.displaySize),
            nowPlayingTextSize: parseNowPlayingTextSize(nextDocs.nowPlayingTextSize ?? nextConfig.nowPlayingTextSize),
            brightnessMode: parseBrightnessMode(nextDocs.brightnessMode ?? nextConfig.brightnessMode),
            brightnessLevel: parseBrightnessLevel(nextDocs.brightnessLevel ?? nextConfig.brightnessLevel),
          });
          setStatus("");
        }
      } catch (error) {
        if (!cancelled && request === revision) setStatus(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const offRefresh = settings.onRefresh(() => void load());
    const offContext = settings.onContextChanged(() => void load());
    return () => {
      cancelled = true;
      authSession.current?.client.disconnect();
      authSession.current = undefined;
      offRefresh();
      offContext();
    };
  }, []);

  const setValue = <K extends keyof Values>(key: K, value: Values[K]) => {
    if (key === "remoteId" || key === "transport") cancelAuth();
    setValues((current) => ({ ...current, [key]: value,
      ...(key === "transport" && value !== current.transport || key === "remoteId" && normalizeRemoteId(String(value)) !== normalizeRemoteId(current.remoteId) ? { token: "" } : {}),
    }));
  };

  const saveValues = async (values: Values, revision = contextRevision.current) => {
    if (saving) return;
    const validationError = validate(values);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setStatus("Saving");
    setSaving(true);
    const write = async (action: () => Promise<unknown>) => {
      if (contextRevision.current !== revision) throw new Error("The selected device changed. Review its settings before saving.");
      await action();
    };
    try {
      if (values.transport !== "webrtc") {
        await write(() => settings.config.set("serverUrl", values.serverUrl.trim()));
      }
      await write(() => settings.config.set("remoteId", normalizeRemoteId(values.remoteId)));
      await write(() => settings.config.set("token", values.token.trim()));
      await write(() => settings.config.set("transport", values.transport));
      await write(() => settings.doc.set("displaySize", values.displaySize));
      await write(() => settings.doc.set("nowPlayingTextSize", values.nowPlayingTextSize));
      await write(() => settings.doc.set("brightnessMode", values.brightnessMode));
      await write(() => settings.doc.set("brightnessLevel", String(Math.max(0.05, Math.min(1, values.brightnessLevel)))));
      if (contextRevision.current !== revision) throw new Error("The selected device changed. Review its settings before saving.");
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    await saveValues(values);
  };

  const connectForLogin = async () => {
    const error = validate(values);
    if (error) { setStatus(error); return; }
    cancelAuth();
    const session = { client: new MassClient(), revision: contextRevision.current, remoteId: normalizeRemoteId(values.remoteId) };
    authSession.current = session;
    session.client.onClose(() => {
      if (authSession.current !== session) return;
      cancelAuth();
      setStatus("WebRTC connection closed");
    });
    setAuthStage("connecting");
    setStatus("Connecting to Music Assistant");
    try {
      // Authentication happens in this foreground page; only the returned token is saved.
      await session.client.connect(session.remoteId, undefined, "webrtc", { tcpRelayOnly: false });
      if (authSession.current !== session) return;
      setAuthStage("login");
      setStatus("Connected");
    } catch (error) {
      if (authSession.current !== session) return;
      cancelAuth();
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const signIn = async () => {
    const session = authSession.current;
    if (!session || authStage !== "login" || !username.trim() || !password) return;
    setAuthStage("signingIn");
    setStatus("Signing in");
    try {
      const token = await session.client.login(username.trim(), password);
      if (authSession.current !== session) return;
      const next = { ...values, remoteId: session.remoteId, token };
      setValues(next);
      setPassword("");
      await saveValues(next, session.revision);
      if (authSession.current === session) cancelAuth();
    } catch (error) {
      if (authSession.current !== session) return;
      setAuthStage("login");
      setPassword("");
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main>
      <h1>Music Assistant</h1>
      <form onSubmit={save}>
        {values.transport === "webrtc" ? (
          <label>Music Assistant Remote ID
            <input value={values.remoteId} onChange={event => setValue("remoteId", event.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
          </label>
        ) : (
        <label>
          {urlLabel(values.transport)}
          <input
            value={values.serverUrl}
            onChange={(event) => setValue("serverUrl", event.target.value)}
            placeholder={urlPlaceholder(values.transport)}
            inputMode="url"
          />
        </label>
        )}
        {values.transport === "webrtc" && (
          <section className="setting-group">
            {authStage === "idle" || authStage === "connecting" ? (
              <button type="button" onClick={() => void connectForLogin()} disabled={saving || authStage === "connecting"}>
                {authStage === "connecting" ? <LoaderCircle size={18} /> : <Link size={18} />} {authStage === "connecting" ? "Connecting" : "Connect WebRTC"}
              </button>
            ) : (
              <>
                <label>Music Assistant username<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" disabled={authStage === "signingIn"} /></label>
                <label>Music Assistant password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" disabled={authStage === "signingIn"} /></label>
                <div className="auth-actions">
                  <button type="button" disabled={saving || authStage === "signingIn" || !username.trim() || !password} onClick={() => void signIn()}><LogIn size={18} /> Sign in and save</button>
                  <button type="button" aria-label="Cancel sign in" title="Cancel sign in" onClick={cancelAuth}><X size={18} /></button>
                </div>
              </>
            )}
          </section>
        )}
        <label>
          {tokenLabel(values.transport)}
          <input
            value={values.token}
            onChange={(event) => setValue("token", event.target.value)}
            placeholder={tokenPlaceholder(values.transport)}
            type="password"
          />
        </label>
        <label>
          Connection path
          <select
            value={values.transport}
            onChange={(event) => setValue("transport", event.target.value as Values["transport"])}
          >
            <option value="homeassistant">Home Assistant / Nabu Casa</option>
            <option value="webrtc">Music Assistant WebRTC</option>
            <option value="bridgething">BridgeThing companion network</option>
            <option value="direct">Direct browser connection</option>
          </select>
        </label>
        <section className="setting-group">
          <h2>Display</h2>
          <label>
            Display size
            <select
              value={values.displaySize}
              onChange={(event) => setValue("displaySize", event.target.value as Values["displaySize"])}
            >
              <option value="standard">Standard</option>
              <option value="large">Large</option>
              <option value="xlarge">Extra large</option>
            </select>
          </label>
          <label>
            Now Playing text
            <select
              value={values.nowPlayingTextSize}
              onChange={(event) => setValue("nowPlayingTextSize", event.target.value as Values["nowPlayingTextSize"])}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
              <option value="xlarge">Extra large</option>
            </select>
          </label>
          <label>
            Brightness mode
            <select
              value={values.brightnessMode}
              onChange={(event) => setValue("brightnessMode", event.target.value as Values["brightnessMode"])}
            >
              <option value="auto">Auto</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <label>
            Brightness {Math.round(values.brightnessLevel * 100)}%
            <input
              type="range"
              min="5"
              max="100"
              value={Math.round(values.brightnessLevel * 100)}
              onChange={(event) => setValue("brightnessLevel", Number(event.target.value) / 100)}
            />
          </label>
        </section>
        <div className="actions">
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
          <button type="button" onClick={() => settings.done()}>
            Done
          </button>
        </div>
      </form>
      {status && <p>{status}</p>}
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
