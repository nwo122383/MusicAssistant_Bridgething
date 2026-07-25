# Car Thing Music Assistant

A Car Thing-native controller for Music Assistant. The current target is a
BridgeThing webapp that can connect to Music Assistant directly or through Home
Assistant / Nabu Casa using the BridgeThing companion app.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:4173`, then enter the Music Assistant server URL (for example `http://192.168.1.50:8095`) in Setup. If Music Assistant authentication is enabled, enter the username and password once; the returned device token is stored in browser local storage.

## BridgeThing build and release

Build the BridgeThing webapp and settings page:

```bash
npm run build:bridgething
```

Create the installable release zip:

```bash
npm run release:bridgething
```

The zip is written to `release/carthing-music-assistant-bridgething-v0.1.0.zip`.
Upload that file to a GitHub Release. Its contents are rooted at the BridgeThing
webapp level, including `manifest.json`, `index.html`, `settings.html`, and
`assets/`.

For Home Assistant / Nabu Casa setups, use the Home Assistant URL and a long-lived
access token in the BridgeThing companion settings. Username/password login is
only for direct Music Assistant auth when that is enabled.

For PC-managed USB setup, build and run the bridge:

```bash
npm run build
npm run bridge
```

Open `http://localhost:4173/setup` on the PC. The bridge uses the supplied
password once, stores only the resulting Music Assistant token in the ignored
`.carthing/bridge-config.json`, proxies Music Assistant HTTP/WebSocket traffic,
and automatically provisions the Car Thing UI through the USB tunnel.

For a Car Thing preview through an SSH reverse tunnel, start the development
server with `MASS_URL` set to the real Music Assistant URL. Use the production
preview (`npm run build`, then `npm run preview`) because the device's Chromium
69 cannot parse Vite's modern hot-reload client. On the Car Thing,
configure the interface to use `http://127.0.0.1:4173/mass`; Vite proxies its
HTTP artwork and WebSocket API traffic to Music Assistant.


The UI targets the Car Thing's 800×480 display. Browser controls corresponding to Car Thing hardware are:

- Dial: horizontal mouse wheel or trackpad scroll
- Dial press: Enter
- Back: Escape
- Settings: M
- Preset keyboard events are disabled in the normal PC interface. The Car Thing
  launcher uses `?hardware=carthing` to enable its physical number buttons.

## Architecture

- `src/lib/MassClient.ts`: native Music Assistant WebSocket protocol client used over USB/local networking.
- `src/hooks/useHardware.ts`: Car Thing wheel and button event mapping.
- Bluetooth will use the same command boundary through a local daemon and Android RFCOMM relay. It is intentionally not coupled to the UI state model.

## Android relay prototype

The first phone-only transport prototype lives in `android-relay/`. Its
Car Thing service uses a separate authenticated RFCOMM profile on channel 3,
allowing Nocturne's channel-2 companion connection to remain active. Install or
remove the reversible device service with:

```powershell
.\scripts\install-android-relay.ps1
.\scripts\remove-android-relay.ps1
```

## Firmware safety

No firmware is included or flashed at this stage. Build and browser validation come first. Device packaging will retain a known-working Nocturne image and recovery procedure.

## Reversible Car Thing preview

With a Nocturne 4 device connected over USB and reachable at `172.16.42.2`:

```bash
bash scripts/install-device-preview.sh
```

The script builds with physical preset-button support, saves the existing UI at
`/opt/nocturne/webapps/ui.nocturne-backup`, replaces only the served web files,
and restarts Chromium. It does not write a firmware partition. Restore with:

```bash
bash scripts/restore-nocturne-ui.sh
```

## Side-by-side Nocturne installation

The side-by-side installer keeps Nocturne as the boot/default interface, adds a
small `MA` launcher to it, and installs this app at `/music-assistant/`. The
Music Assistant navigation bar includes a `Nocturne` button, and pressing the
physical Back button from its Now Playing screen also returns to Nocturne.

From Windows PowerShell:

```powershell
cd C:\dev\CarThing
.\scripts\install-side-by-side.ps1
```

The installer backs up Nocturne's original `index.html` before changing it and
does not flash a firmware partition. Restore the untouched Nocturne entry page
and remove the side-by-side files with:

```powershell
.\scripts\restore-side-by-side.ps1
```

To make the side-by-side Music Assistant app open automatically on Car Thing
startup:

```powershell
.\scripts\set-ma-default.ps1
```

This keeps Nocturne installed and only adds a small served config file. The
Music Assistant `Nocturne` button and the physical Back button from Now Playing
return to Nocturne with a session bypass so you can still access it. Restore
Nocturne as the default startup UI with:

```powershell
.\scripts\unset-ma-default.ps1
```
