import { settings } from "@bridgething/client/settings";
import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Values = {
  serverUrl: string;
  token: string;
  transport: "homeassistant" | "bridgething" | "direct";
  displaySize: "standard" | "large" | "xlarge";
  nowPlayingTextSize: "small" | "medium" | "large" | "xlarge";
  brightnessMode: "auto" | "manual";
  brightnessLevel: number;
};

const defaultValues: Values = {
  serverUrl: "",
  token: "",
  transport: "bridgething",
  displaySize: "standard",
  nowPlayingTextSize: "medium",
  brightnessMode: "auto",
  brightnessLevel: 0.55,
};

function validate(values: Values): string | undefined {
  const rawUrl = values.serverUrl.trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "Enter a Music Assistant URL, not a Remote ID";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Music Assistant URL must start with http:// or https://";
  }
  if ((values.transport === "bridgething" || values.transport === "homeassistant") && url.protocol !== "https:") {
    return "BridgeThing Android requires an https:// URL";
  }
  return undefined;
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

function SettingsApp() {
  const [values, setValues] = useState<Values>(defaultValues);
  const [status, setStatus] = useState("Loading settings");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [configEntries, docEntries] = await Promise.all([
          settings.config.list(),
          settings.doc.list(),
        ]);
        const nextConfig = Object.fromEntries(configEntries.map((entry) => [entry.key, entry.value]));
        const nextDocs = Object.fromEntries(docEntries.map((entry) => [entry.key, entry.value]));
        if (!cancelled) {
          setValues({
            serverUrl: nextConfig.serverUrl || "",
            token: nextConfig.token || "",
            transport:
              nextConfig.transport === "homeassistant" || nextConfig.transport === "direct"
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
        if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setValue = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const validationError = validate(values);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setStatus("Saving");
    try {
      await settings.config.set("serverUrl", values.serverUrl.trim());
      await settings.config.set("token", values.token.trim());
      await settings.config.set("transport", values.transport);
      await settings.doc.set("displaySize", values.displaySize);
      await settings.doc.set("nowPlayingTextSize", values.nowPlayingTextSize);
      await settings.doc.set("brightnessMode", values.brightnessMode);
      await settings.doc.set("brightnessLevel", String(Math.max(0.05, Math.min(1, values.brightnessLevel))));
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main>
      <h1>Music Assistant</h1>
      <form onSubmit={save}>
        <label>
          {urlLabel(values.transport)}
          <input
            value={values.serverUrl}
            onChange={(event) => setValue("serverUrl", event.target.value)}
            placeholder={urlPlaceholder(values.transport)}
            inputMode="url"
          />
        </label>
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
          <button type="submit">Save</button>
          <button type="button" onClick={() => settings.done()}>
            Done
          </button>
        </div>
      </form>
      {status && <p>{status}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
