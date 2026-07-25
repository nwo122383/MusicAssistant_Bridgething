# Music Assistant BridgeThing


<img width="4000" height="3000" alt="PXL_20260725_224155920" src="https://github.com/user-attachments/assets/7a5a8ed7-ad05-40df-966d-515caf53f7be" />

<img width="4000" height="3000" alt="PXL_20260725_224137793 MP" src="https://github.com/user-attachments/assets/5388a7c3-02a6-4ba8-942a-266d91ef7b6d" />


A BridgeThing webapp for controlling Music Assistant from a Spotify Car Thing.

The app runs on BridgeThing firmware and is configured from the BridgeThing
companion app. It can connect through Home Assistant / Nabu Casa or, for setups
that expose Music Assistant directly, through Music Assistant's own websocket
API.

## Features

- Now Playing screen with album art, progress, shuffle, repeat, and transport controls.
- Music Assistant library browsing for recent items, playlists, albums, artists, and radio.
- Player selection for available Music Assistant outputs.
- Queue view with physical dial navigation.
- Four physical preset buttons for favorite playlists or library items.
- Volume control using the Car Thing dial with an on-screen volume overlay.
- Brightness, display size, and Now Playing text size settings.

## Install From BridgeThing

This repo publishes a BridgeThing `catalog.v1` source:

```text
https://raw.githubusercontent.com/nwo122383/MusicAssistant_Bridgething/main/docs/catalog.v1.json
```

Add that source in the BridgeThing app store/source screen, then install
`Music Assistant`.

The installable app zip is also stored in this repo at:

```text
docs/music-assistant-bridgething-v0.1.0.zip
```

That zip is referenced by the catalog. You normally submit or add the catalog
URL, not the zip URL directly.

## Configure

Open the BridgeThing companion app on your phone, select the installed
`Music Assistant` app, then open its settings.

For Home Assistant / Nabu Casa:

- Set `Connection path` to `Home Assistant / Nabu Casa`.
- Set `Server URL` to your Home Assistant URL.
- Set `Access token` to a Home Assistant long-lived access token.

For direct Music Assistant:

- Set `Connection path` to `Direct browser connection` or `BridgeThing companion network`.
- Set `Server URL` to the Music Assistant server URL.
- If Music Assistant auth is enabled, use the in-app setup screen on the
  Car Thing for username/password login.

The Car Thing screen also has an app settings page for display preferences,
presets, and direct connection controls. The primary phone-side settings live in
the BridgeThing companion app.

## Build

Install dependencies:

```bash
npm install
```

Build the BridgeThing webapp and companion settings page:

```bash
npm run build:bridgething
```

Create the release zip:

```bash
npm run release:bridgething
```

The zip is written to:

```text
release/music-assistant-bridgething-v0.1.0.zip
```

The release package contains the BridgeThing webapp files rooted at the app
level: `manifest.json`, `index.html`, `settings.html`, and `assets/`.

## Publish A New Version

After changing the app:

```bash
npm run release:bridgething
cp release/music-assistant-bridgething-v0.1.0.zip docs/music-assistant-bridgething-v0.1.0.zip
sha256sum docs/music-assistant-bridgething-v0.1.0.zip
stat -c '%s' docs/music-assistant-bridgething-v0.1.0.zip
```

Update `docs/catalog.v1.json` with the new `updated_at`, `released_at`,
`download.size`, and `download.sha256` values. Keep the app `id` unchanged so
BridgeThing can upgrade existing installs in place.

## Development

Run the local Vite dev server:

```bash
npm run dev
```

This is useful for browser UI work. The real BridgeThing connection path,
hardware buttons, companion settings, and phone networking should be tested on a
Car Thing running BridgeThing.

Useful checks:

```bash
npx tsc -b --pretty false
npm test -- --run
```

## Project Structure

- `src/App.tsx`: main Car Thing UI.
- `src/lib/MassClient.ts`: Music Assistant and Home Assistant transport client.
- `src/lib/bridgething.ts`: BridgeThing config, doc, and hardware helpers.
- `src/hooks/useHardware.ts`: Car Thing wheel and button event mapping.
- `settings/main.tsx`: BridgeThing companion settings page.
- `public/manifest.json`: BridgeThing app manifest.
- `docs/catalog.v1.json`: public BridgeThing catalog source.

## Legacy Prototypes

This project started as a Nocturne/relay experiment. Some older relay and
side-by-side scripts remain in the repo for reference, but the current
recommended install path is BridgeThing plus the BridgeThing companion app.

The old Android relay prototype is in `android-relay/`, and the old Car Thing
relay notes are in `docs/android-relay-protocol.md`.
