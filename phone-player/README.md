# CarThing Phone Player

Beta: **0.2.0-beta.1**, Android 12/API 31 or newer.
[Download the signed APK](https://github.com/nwo122383/MusicAssistant_Bridgething/releases/download/v0.1.8-beta.1/carthing-phone-player-v0.2.0-beta.1.apk)
from the [opt-in beta release](https://github.com/nwo122383/MusicAssistant_Bridgething/releases/tag/v0.1.8-beta.1).
The normal BridgeThing store catalog remains on stable 0.1.7.

This optional Android app supplies a native phone speaker for Music Assistant.
The setup is BridgeThing on the phone, our MA webapp ZIP on the Car Thing, and
this one phone-player APK. The official MA Android app, a PC relay, extra
Bluetooth data connection, and new server-side components are **not required**.
Home-speaker-only control does not require this APK.

## Supported Connection

The helper uses an existing **Home Assistant / Nabu Casa remote HTTPS address**
and the **Music Assistant app/add-on with HA ingress**. The HA account needs the
access required to discover that add-on and create ingress sessions. HA Core
without MA add-on ingress is not covered by this phone-audio path.

Authentication, credential renewal, and encrypted Sendspin run natively on the
phone. The current implementation needs MA encrypted Sendspin support (schema
45 or newer); MA 2.10.13 was used for testing.

**Native helper MA Remote-ID/WebRTC login/audio is not implemented yet.** The
controller's existing WebRTC option remains available, but an MA Remote ID alone
does not configure this APK's audio receiver. The internal Sendspin transport
adapter name does not change the actual HA ingress connection.

## One-Time Setup

1. Pair and connect the Car Thing using stock BridgeThing. Import the
   0.1.8-beta.1 webapp ZIP as an app update, not a firmware image.
2. Install the APK on the phone using Android's normal installer. Approve
   installation from that download source if prompted.
3. Open **CarThing Phone Player**, enter the remote HA HTTPS address, and choose
   **Sign in to Home Assistant**. Use your HA account, not Nabu Casa billing
   credentials. No manually created token is needed.
4. Grant **Nearby Devices** permission; notifications are recommended for status.
5. Select the intended Car Thing, choose **Enable automatic startup**, and approve
   Android's companion-device association.
6. In the Car Thing app's Players view, select **CarThing Phone** and assign its
   smartphone volume control. The dial then changes the phone's media volume.
7. Connect the phone's normal media output to the car stereo's Bluetooth/AUX
   adapter. The phone receives and decodes music; the Car Thing controls it.

The controller's HA login in BridgeThing and the helper's HA login are separate
one-time authorizations. The helper cannot read another app's private login.
The native sign-in page uses a dedicated WebView with PKCE and state validation;
it does not collect or store your HA password.

## Daily Use And Background Playback

Associated-device presence starts the receiver when the Car Thing returns.
The intended flow does not require opening multiple phone screens each drive,
and association alone does not automatically start music.

A foreground service owns the audio engine and media session independently of
the activity. A partial CPU wake lock protects actual playback, including
buffered audio while the connection recovers. Initial connection, buffering,
and recovery receive a bounded 60-second wake window; repeated retry/status
updates cannot renew it indefinitely.

Car Thing presence is a control-link signal, not the phone audio-output route.
A brief presence loss does not shut down active phone audio. Once audio is idle,
an absent Car Thing triggers a 15-second departure grace; returning presence
cancels it. Stalled buffering/recovery can defer shutdown only within its bounded
window. **Stop phone player** still stops the receiver immediately. No home
speaker receives a pause or stop command.

Forced stops, revoked permissions, Android background restrictions, and a
disabled automatic-start setting can prevent startup. Reopen the helper after
a force stop. The app does not bypass Android's restrictions or guarantee
one-minute readiness.

## Updates And Stable Speaker Identity

Install updates in place. **Do not uninstall or clear app data to troubleshoot**:
that can discard the persistent Sendspin identity and create another MA player.

The engine reuses its cryptographic identity across reconnects, service/process
restarts, and compatible signed APK updates. Changing the display name does not
create a new player. Identity and HA credentials use private Android-Keystore-
encrypted storage; app backup is disabled, and identity writes commit before
the receiver advertises itself.

The old official MA app's My Phone player is a different app's identity. A
one-time switch to CarThing Phone is expected; old players are not deleted.
If Android reports a signature mismatch, use the matching signed update rather
than uninstalling as a workaround. The beta APK retains the development helper's
signing identity and uses a non-debuggable release build.

## Known Beta Limits

- Consistent sub-minute cold-car/Bluetooth startup is not established. Stock
  BridgeThing's paging/retry delay is separate from native receiver readiness.
- Brief audio underruns remain under investigation. Cellular handoffs, actual
  car Bluetooth audio routing, and longer screen-off drives need more testing.
- HA add-on ingress is required for this APK. Native MA Remote-ID/WebRTC support
  remains future work.
- The controller waits for an unavailable selected phone; it does not silently
  fall back to a home speaker.
- A provider may supply only station artwork rather than a song album cover.

The stable 0.1.7 release did not publish a helper APK. Its earlier helper source
depended on the official MA Android app; those instructions do not describe this
standalone beta implementation.

## Verification

The implementation passed 26 helper unit tests and 302 pinned Sendspin tests.
Android lint completed with zero errors and 15 warnings. In-place development
updates retained the existing login, companion association, and speaker identity.

A seven-minute screen-off cellular run with Android's simulated-unplugged battery
state retained the foreground receiver, CPU protection, active audio, and
controller connection at every sample. Audio frame counters advanced throughout.
The underrun counter increased near the end: this is not a completely glitch-
free driving result. The user confirmed music was audible but did not monitor
every moment of the run.

Separate controlled checks confirmed active audio survived presence loss beyond
the former shutdown threshold, idle departure released the receiver/wake lock,
and simulated return reused the same speaker without opening a phone activity.
These are not real Bluetooth cold-start or car-stereo routing benchmarks. See
[connection behavior and remaining checks](../docs/connection-recovery.md).
Raw device logs and the detailed investigation remain local.

## Build And Test

Use JDK 17 or newer and Android SDK 36, with `ANDROID_HOME` configured. The old
relay project supplies the Gradle wrapper only; it is not a runtime dependency.

```powershell
cd phone-player
..\android-relay\gradlew.bat -p . :app:assembleDebug :app:testDebugUnitTest :sendspin:testAndroidHostTest --no-daemon
```

The development APK is `app/build/outputs/apk/debug/app-debug.apk`.
For a non-debuggable unsigned build, run `:app:assembleRelease`; then sign
`app/build/outputs/apk/release/app-release-unsigned.apk` using your retained
private Android signing key and verify its signature/alignment before release.
A separately generated signing key cannot update the published APK in place.

Do not commit signing keys, local SDK paths, credentials, app-data exports, or
device logs. The reused Sendspin engine is pinned and licensed under
[sendspin/UPSTREAM.md](sendspin/UPSTREAM.md), with its Apache-2.0 license and notice
included in the APK. Source is vendored so community builders do not need a
GitHub Packages token.

On-device tests are under `app/src/androidTest`. Private development credential
provisioning is test-only, is not included in the release APK, and does not
place a session in an intent, public asset, or command-line argument.

Before promoting stable, complete real car-entry, extended screen-off driving,
out-of-range return, cellular-handoff, and actual stereo-output tests. Retain the
same signing key for future upgrades, publish APK checksums separately from the
ZIP, and keep setup/limitations distinct from the stable store release.
