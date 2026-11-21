# CarThing Phone Player

Experimental Android helper for the Music Assistant BridgeThing webapp. It uses
the official MA app's exported Android MediaBrowser service to keep its native
Sendspin player connected. It neither replaces BridgeThing nor opens MA's screen
as part of normal operation. No accessibility service, private API, second
Bluetooth data connection, server URL, or MA credential is required by the helper.

## Initial Setup

1. Install the official Music Assistant Android app, connect it to your server
   (WebRTC works), sign in, and enable its local Sendspin player. This is a
   one-time prerequisite. The MA app must remain installed.
2. Install this helper and grant Nearby Devices permission. Notifications are
   recommended so its foreground connection status is visible.
3. Choose your already-paired Car Thing and enable automatic startup. Approve
   Android's device-association dialog. This does not unpair BridgeThing.
4. Select the phone player in the Car Thing's MA app. Its smartphone icon assigns
   that player's volume wheel to the connected phone's media volume.
5. Connect the phone to the car stereo for media audio. The Car Thing controls
   playback; it does not carry the music audio to the stereo.

Android companion-device presence starts the helper when the selected Car Thing
connects, warming MA's media service before you select music. A foreground
connected-device service holds the MediaBrowser connection. A 15-second grace
period tolerates short Bluetooth interruptions. The helper releases its media
service connection when it stops; it deliberately never sends a global pause
that could affect an unrelated home speaker.

Force-stopping either app, revoking permissions, signing out of MA, or disabling
its local player prevents automatic operation. Launch and re-enable the affected
app after a force stop. The helper does not bypass Android restrictions.

## Build

Use JDK 17 or newer, Android SDK 36, and set `ANDROID_HOME`. The repository's
existing Android relay project supplies the Gradle wrapper only:

```powershell
cd phone-player
..\android-relay\gradlew.bat -p . :app:assembleDebug --no-daemon
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

## Verification Status

Verified on a Pixel 10 with MA Android 0.17.0 and MA Server 2.10.13: external
MediaBrowser connection, native Sendspin registration as `My Phone`, and user-
confirmed music playback. The foreground-service/presence implementation builds,
but automatic locked-phone/cold-car startup still requires device-association
approval and live testing. Do not treat a successful service bind as proof that
the speaker is ready or assume a startup time until it is measured.

The integration depends on MA continuing to expose its Android media service.
It discovers that service using Android's standard media-browser intent rather
than depending on its implementation class name.
