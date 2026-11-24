# Connection Recovery

The Car Thing controller and the Android phone player have separate connections.
Recovering control must not restart working audio, change the selected speaker,
create a new phone identity, or replay the last playback command.

These behaviors are available in the opt-in 0.1.8-beta.1 ZIP and optional
0.2.0-beta.1 APK. The normal store catalog remains on stable 0.1.7.

## Controller Behavior

- Concurrent player/queue refreshes share one in-flight snapshot per connection.
- A failed snapshot does not immediately disconnect a working session.
- HA mode uses WebSocket ping/pong health checks; other MA paths probe the server.
- Two consecutive failed probes reset a silent socket; confirmed closure starts
  recovery immediately. Checks do not overlap.
- Health requires a real response, not just cached song information.
- Old replies and timeouts cannot update a replacement connection.
- Phone-backed modes wait when BridgeThing reports no gateway, then retry when
  it returns. Direct LAN mode is unaffected.
- Gateway polling can detect recovery after a missed event. It does not reset
  Bluetooth or interfere with an active pairing/connection negotiation.
- Settings echoes and inactive connection fields do not reset a working session.
- HA ingress-session renewals are shared; failures can retry on a later request.
- An unavailable selected phone never redirects playback to a home speaker.
- Verified HA phone-player startup can load the selected phone and its queue
  before loading the wider home-speaker list.

An HA ping proves HA control connectivity, not every MA provider or audio player.
Ingress and actual player availability are checked separately.

## Native Phone Audio Lifetime

A foreground media service owns Sendspin independently of the phone activity.
Actual playback retains a partial CPU wake lock, including buffered playing
audio while disconnected. Initial connection, buffering, and network recovery
get a continuous 60-second wake window; retries cannot extend it indefinitely.
Idle, failure, explicit shutdown, and recovery expiry release CPU protection.

Car Thing presence is not the phone's audio-output route. A brief presence loss
must not stop active music. Once audio becomes idle, an absent Car Thing uses a
15-second departure grace; returning presence cancels it. Stalled buffering or
recovery can defer idle shutdown only within its bounded window.

Playing, buffering, reconnecting, and readiness come from structured engine
state, not status-message text. Nonplaying reconnects advertise buffering rather
than paused. A failed departure-notification delivery does not force-stop an
existing audio service. Calls and audio-output interruptions still follow the
engine's audio-focus handling.

## Artwork Over The Phone

HA artwork uses the phone network and a cached browser blob. The controller
prefers HA's signed local media-player picture route and authenticated MA ingress
rather than requiring the Car Thing to reach a remote CDN itself.

For SiriusXM, the exact host `pri.art.prod.streaming.siriusxm.com` may be mapped
to `https://albumart.siriusxm.com`, preserving its artwork path/query. This route
sends no HA authorization or ingress cookie to the external host. Redirects and
nonstandard hosts/ports are rejected; certificate verification is not disabled.

A provider may supply only a station logo. The controller cannot invent a song's
album cover when no song artwork is present, and should not substitute an old
track's cover.

## Local Diagnostics

The bounded session-local controller trace at `carthing-ma-startup-v1` records
named phases, attempt numbers, and elapsed milliseconds. It does not record
server URLs, credentials, passwords, or player IDs.

The helper logs playback/recovery flags and wake-lock transitions. Treat all
device exports and general Android logs as sensitive before sharing. Raw device
captures and the detailed Bluetooth investigation remain local, not in GitHub
or the beta downloads.

## Validation And Limits

The native implementation passed 26 helper tests and 302 pinned Sendspin tests.
Android lint completed with zero errors and 15 warnings. A seven-minute
screen-off cellular test using Android's simulated battery state retained the
foreground receiver, CPU protection, advancing audio frames, selected phone, and
controller connection in every sample. The underrun counter increased near the
end, so this is not a completely dropout-free audio claim or a physical driving
test.

A controlled presence-loss check kept active audio running beyond the previous
shutdown threshold. After an intentional pause, idle shutdown and simulated
return reused the original speaker identity and released idle CPU protection.
This is not a Bluetooth cold-start benchmark.

Stock BridgeThing paging/retry delays remain unresolved. The beta does not
guarantee sub-minute startup, uninterrupted cellular handoffs, or all car-stereo
Bluetooth routes. The intermittent Nothing playing report was not reproduced
during the seven-minute check; it is not claimed fixed by this helper change.

Before stable release, repeat real power-on, out-of-range return, longer
screen-off driving, cellular handoffs, and car-audio routing. Confirm the same
phone remains selected and no home speaker receives unintended playback.
