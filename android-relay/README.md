# Car Thing MA Relay for Android

This is the first transport prototype for replacing the PC bridge. It connects
to the dedicated `Car Thing MA Relay` RFCOMM service, performs a versioned
handshake, measures ping latency, and runs a 64 KiB round-trip throughput test.

It intentionally does not connect to Music Assistant yet. The transport must
first be validated while Nocturne Companion remains connected.

## Requirements

- Android Studio Quail or Android SDK command-line tools
- JDK 17
- Android SDK Platform 36 and Build Tools 36
- A phone running Android 12 or newer
- The Car Thing relay installed with `scripts/install-android-relay.ps1`

## Build and install

Open this directory in Android Studio, allow Gradle synchronization, then run
the `app` configuration on the Pixel. From a configured command line:

```powershell
cd C:\dev\CarThing\android-relay
.\gradlew.bat assembleDebug
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

Grant Nearby Devices permission, select the already-paired Nocturne device,
and press Connect. A successful test shows a handshake, a ping time, and a
throughput result without disconnecting Nocturne Companion.

The shared wire format is documented in
[`docs/android-relay-protocol.md`](../docs/android-relay-protocol.md).
