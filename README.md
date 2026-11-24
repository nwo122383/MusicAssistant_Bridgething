# Music Assistant BridgeThing


<img width="3233" height="1827" alt="PXL_20260725_224049965" src="https://github.com/user-attachments/assets/410cd873-713a-48f3-b2fe-b46b3bd092b8" />

<img width="3168" height="1510" alt="PXL_20260725_224137793 MP (1)" src="https://github.com/user-attachments/assets/3fbe786d-0b5a-431c-83ad-76b1a89e3c51" />




A Music Assistant controller for Spotify Car Thing running BridgeThing.

**Latest stable release: 0.1.7.** [Stable upgrade notes](docs/releases/v0.1.7.md).

**Opt-in beta: 0.1.8-beta.1**, with the optional **CarThing Phone Player
0.2.0-beta.1** Android APK. [Beta downloads](https://github.com/nwo122383/MusicAssistant_Bridgething/releases/tag/v0.1.8-beta.1)
and [beta setup, changes, and known limitations](docs/releases/v0.1.8-beta.1.md).
The normal BridgeThing store source stays on stable 0.1.7; updating the source
does not opt you into this beta.

## Requirements

- BridgeThing device firmware/libbridgething **0.17.1 or newer**.
- A current BridgeThing companion app. Android **0.17.0** was used for testing.
- A Music Assistant server. Tested with **MA 2.10.13**.
- An existing MA playback device, or a separately configured phone audio player.

No PC relay or custom BridgeThing firmware is needed for the webapp. The optional
phone-audio helper is separate and experimental; see Phone Audio below.

## Install Or Update

Music Assistant is listed in the BridgeThing app directory. If you already use
this source, refresh it and install the latest compatible version. There is no
need to add a new source for each update.

To add the source manually, paste this URL in BridgeThing's source/store screen:

```text
https://raw.githubusercontent.com/nwo122383/MusicAssistant_Bridgething/main/docs/catalog.v1.json
```

For manual webapp installation, use
[the 0.1.7 ZIP](docs/music-assistant-bridgething-v0.1.7.zip). This is an app bundle,
**not** a Car Thing firmware image. The app ID stays the same across releases so
BridgeThing can update an existing installation in place.

## Connect And Sign In

On your phone, open BridgeThing, select Music Assistant, and open its settings.
Choose the connection path that matches your setup. The credentials are not
interchangeable:

| Connection Path | Address | Authentication |
| --- | --- | --- |
| Music Assistant WebRTC | MA Remote ID | MA username/password after connecting, or an existing MA token |
| Home Assistant / Nabu Casa | Remote HA HTTPS URL | Beta: Sign in to Home Assistant; advanced HA token supported. Stable 0.1.7: HA long-lived access token |
| BridgeThing companion network | Reachable MA HTTPS URL | MA access token, or MA login on the Car Thing |
| Direct browser connection | MA HTTP/HTTPS URL reachable by the Car Thing browser | MA access token, or MA login on the Car Thing |

### Music Assistant WebRTC

This is the Remote ID connection path for reaching MA without a public MA server
URL or a PC relay.

1. In Music Assistant, open Settings > Remote Access and enable remote access.
2. Copy its Remote ID.
3. If you use Nabu Casa, enable **WebRTC Connections** in Home Assistant Cloud
   settings. This BridgeThing route requires TCP/TLS TURN, because the phone-backed
   network proxy carries TCP rather than UDP.
4. In our BridgeThing phone settings, choose **Music Assistant WebRTC**, enter the
   Remote ID, and press **Connect WebRTC**.
5. Once connected, enter your **Music Assistant** username and password, then
   press **Sign in and save**.

You do not need to generate a token manually. The optional access-token field is
an alternative for people who already have one. The sign-in form uses an MA
account, not Home Assistant OAuth credentials.

The password is not persisted by our app. The returned token is saved in
BridgeThing's app configuration and the Car Thing's browser storage for
reconnects. Treat device storage and backups as sensitive.

The connection uses Music Assistant's remote transport with DTLS fingerprint
verification. API traffic and remote artwork use the encrypted WebRTC connection.
WebRTC control does not, by itself, register the phone as a speaker.

### Home Assistant / Nabu Casa

In **0.1.8-beta.1**, choose **Home Assistant / Nabu Casa**, enter your remote HA
HTTPS URL, and press **Sign in to Home Assistant**. Sign in with your HA account
on HA's own page, then return to BridgeThing. The app saves renewable credentials;
you do not need to create a token manually. The **Advanced access token** option
still accepts an HA long-lived token. An MA token will not work for this path.

Stable **0.1.7** still uses a manually supplied HA long-lived access token.
The browser-login feature requires the beta ZIP, not just a source-code update.
See [HA sign-in and credential handling](docs/home-assistant-login.md).

AI Radio and group management use MA add-on ingress through the existing HA
connection. They need HA Supervisor/admin access and an enabled MA ingress panel.
No second URL or MA token is needed for those features in HA mode.

### Other MA URL Connections

Use **BridgeThing companion network** when MA has a reachable HTTPS address.
Use **Direct browser connection** only when the Car Thing browser itself can
reach the URL. A home LAN address is not a remote-car connection.

For these paths, use MA authentication, not an HA token. MA username/password
login remains available on the Car Thing setup screen.

## Features And Controls

- Now Playing with artwork, elapsed time, shuffle, repeat, and transport controls.
- Optional fullscreen Now Playing with larger artwork, text, and controls.
- Library tabs for Recent, Playlists, Albums, Artists, Radio, and AI Radio.
- Cached tab results, Recent/Playlists preloading, small first pages, Load More,
  and a refresh button. First loads and uncached artwork still depend on the link.
- Players/Groups views, current group membership, compatible member editing, and
  a confirmed Ungroup All recovery action. Fixed group members remain locked.
- Queue browsing, track selection, play-next, and removal.
- Four physical preset buttons: select a library item and hold a top button to
  save it; press the button later to play it on the selected player.
- Dial volume with an on-screen bar and equal 2-point changes across grouped
  speakers. The Players volume panel also supports individual member control
  without ungrouping and an explicit Sync to lowest action.
- Outside the volume panel, the dial scrolls Players and selects queue items;
  pressing it plays the selected queue item in Queue.
- BridgeThing voice playback requests using the selected player. Availability
  and speech recognition depend on BridgeThing.
- Phone settings for display size, Now Playing text size, and brightness.

**Ungroup All can affect multiple rooms and may stop playback.** It releases
active grouping without deleting saved group definitions. Offline speakers may
need to reconnect before MA can release them.

## Group And Individual Volume

For a grouped playback player, the normal volume dial changes each available,
powered-on speaker by the same **2 points**. For example, levels of 9 and 24
become 11 and 26 when turned up one step. This preserves the offset between
speakers rather than proportionally scaling their levels. Each speaker is
limited independently to 0-100.

Open **Players** and tap the **sliders icon** beside a group or grouped speaker:

- **Whole group** is selected by default. The dial adjusts all eligible members.
- Select a member to adjust only that speaker with the dial. It remains in the
  group, and the selected playback device does not change.
- **Sync to lowest** is optional: pressing it sets eligible members to the
  quietest member's level. It is a one-time action, not a background mode, and
  never runs automatically when opening the panel or reconnecting. Equal-point
  dial adjustments then keep those matched levels together, unless a member
  reaches a limit or is changed separately.
- **Done**, the close button, or leaving Players restores the normal dial target.
  Volume changes already made are kept.

Unavailable, powered-off, and non-volume-controllable members are skipped;
these controls do not power on speakers or start playback. Nested groups are
resolved to their controllable members without adjusting shared members twice.
Group volume over Home Assistant/Nabu Casa uses MA ingress, as the group editor
does, so that route needs the MA add-on and HA ingress access. Ordinary standalone
HA volume and the configured Android phone-volume route remain unchanged.

## Fullscreen Player

Tap the small **expand icon** at the top-right of Now Playing to hide the bottom
tabs and enlarge the artwork, track text, and playback controls. Tap the collapse
icon in the same corner, or press the physical **Back** button, to restore the
tabs. Playback continues. The normal layout and its size preferences are unchanged.

## AI Radio

Configure MA's AI Radio plugin, its AI/speech engines, and saved shows in MA
first. Then open Library > AI Radio on the Car Thing and play a show on the
selected player. Switching an already-running show asks for confirmation.

Show creation and host editing remain in Music Assistant. This tab is not a
replacement for configuring the plugin on the server.

## Phone Audio

The Car Thing is the controller; the phone receives music and routes it to the
car stereo through the phone's normal media output.

If the official MA Android app's local Sendspin player is enabled and connected,
it can appear in Players, usually as **My Phone** unless you named it differently.
Select that output in our Car Thing app. If it is hidden, check the player's
visibility in Music Assistant.

Use the **smartphone button** beside that player in Players to assign the volume
wheel to the connected phone's actual media volume. This assignment is per
player: Sonos and other speakers retain normal MA volume control. The on-screen
volume bar follows Android's reported level.

A selected phone assigned this way is preserved while it reconnects. The app
waits for it rather than silently playing through a home speaker.

### Optional Android Helper: Beta

The [0.2.0-beta.1 phone player](phone-player/README.md) owns a native Sendspin
receiver. It does **not** require the official MA Android app, a PC relay, or an
additional server component. It is a separate Android APK, not part of the
BridgeThing webapp ZIP, and is unnecessary for controlling home speakers.

For the beta phone-audio route, use an existing **Home Assistant / Nabu Casa**
remote HTTPS address and the **Music Assistant app/add-on with HA ingress**.
Open CarThing Phone Player once, sign in to HA, grant its permissions, select
your Car Thing, and enable automatic startup. In our Car Thing app, select
**CarThing Phone** and assign its smartphone volume control. Route the phone's
normal media output to the car stereo's Bluetooth/AUX adapter.

The helper and controller each need their own one-time sign-in; they do not
share private credentials between Android apps. **Native helper MA Remote-ID /
WebRTC login is not implemented**. The controller's WebRTC option remains
available, but an MA Remote ID alone does not configure phone audio in this APK.

The intended daily flow is automatic associated-device startup, not opening
multiple phone screens before each drive. Screen-off playback and stable player
identity have been tested, but **consistent sub-minute cold startup is not
established**, and brief audio-buffer gaps remain under investigation. Force
stopping an app or Android background restrictions can prevent automatic startup.
Read the [beta limitations and verification](docs/releases/v0.1.8-beta.1.md)
before relying on this experimental car setup.

Stable 0.1.7 did not publish an APK. Its earlier helper source depended on the
official MA app; do not mix those instructions with the standalone beta helper.

## Development

```bash
npm ci
npm test -- --run
npm run build:bridgething
```

For browser UI development, `npm run dev` starts Vite. A development localhost
page is not the end-user setup flow: normal users configure the installed app
through BridgeThing on their phone. Hardware, phone networking, and reconnect
behavior need testing on a real Car Thing.

## Prepare And Publish A Release

For the current beta, run `npm run build:bridgething` and
`npm run package:bridgething`, then publish the ZIP and optional signed APK in a
GitHub **prerelease**, without changing the stable catalog or its hosted files.
The steps below are for a later stable store release.

1. Set the same new version in `package.json` and
   `public/manifest.json`, and update the lockfile.
2. Add that version's changelog, minimum BridgeThing version, and permissions to
   `docs/catalog.v1.json`. Keep the existing app UUID unchanged.
3. Write the release notes under `docs/releases/`.
4. Run:

```bash
npm test -- --run
npm run release:bridgething
```

The release command builds the app and phone settings page, packages the ZIP,
copies the ZIP and matching hosted settings page into `docs/`, and updates
the catalog's sizes, SHA-256 checksums, URLs, and release timestamp.

For 0.1.7, the installable archive is written to:

```text
release/music-assistant-bridgething-v0.1.7.zip
docs/music-assistant-bridgething-v0.1.7.zip
```

Commit and push the source, release notes, generated files in `docs/`, and
updated catalog to `main`. Create the matching GitHub release and attach the
ZIP from `release/`.

BridgeThing periodically rechecks the same catalog URL, so a published new
version does not require another source submission. Its directory/app may need
time or a refresh to show the update. Pushing source code alone does not rebuild
an already-published ZIP; run the release command for each version.

The package contains only the built webapp, settings page, assets, and license
notice. Source maps, local connection settings, diagnostics, and the experimental
Android helper are not bundled.

## Project Layout

- `src/`: Car Thing UI, MA/HA/WebRTC clients, and tests.
- `settings/`: self-contained BridgeThing phone settings page.
- `public/manifest.json`: stable app identity and config declarations.
- `docs/catalog.v1.json`: public catalog and versioned download metadata.
- `docs/releases/`: release notes.
- `phone-player/`: optional native Android Sendspin player and its setup guide.
- `scripts/`: build/package and older development utilities.

## Legacy Prototypes

This started as a Nocturne/relay experiment. The old `android-relay/` project,
PC relay, and side-by-side scripts remain for reference. They are not required
for the current BridgeThing webapp. The new optional `phone-player/` helper is
a different project and does not use that old relay transport.
