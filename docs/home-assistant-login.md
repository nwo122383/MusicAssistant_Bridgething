# Home Assistant Browser Sign-In

Available in the opt-in **0.1.8-beta.1** ZIP, not the stable 0.1.7 store download.
It changes controller authentication; the optional native phone audio player
has its own one-time HA sign-in. See the [phone-player guide](../phone-player/README.md).

## User Setup

1. Open Music Assistant's settings in the BridgeThing phone app.
2. Select **Home Assistant / Nabu Casa**.
3. Enter the Home Assistant remote HTTPS URL.
4. Select **Sign in to Home Assistant**.
5. Sign in on Home Assistant's own browser page, including MFA if enabled.
6. Return to BridgeThing. Successful sign-in saves the app's settings.

Use the Home Assistant account, not the Nabu Casa billing-account credentials.
No manual long-lived token creation is required. **Advanced access token**
remains available for existing manual-token installations.

## Credential Handling

The flow uses BridgeThing's browser authorization callback, state verification,
and S256 PKCE. Passwords and MFA codes are not collected or saved by our app.
The PKCE hash uses a bundled SHA-256 implementation because the Android settings
WebView may not expose SubtleCrypto at its null origin. Secure platform randomness
is still required; there is no weak-randomness or non-PKCE fallback. The callback
validator accepts the exact HTTPS callback or BridgeThing's native callback,
with the same state verification for both.

The renewable access/refresh credentials are serialized in the existing app-
scoped `token` secret configuration field, bound to the HA server origin.
Secret-field storage is still credential storage; this does not assert that
BridgeThing encrypts it at rest. Never publish device config exports or logs
containing this field.

The Car Thing refreshes an expired access token through BridgeThing's phone
network connection before connecting to HA. This does not require opening the
settings page again. Revoked credentials require a fresh browser sign-in.

Changing devices or servers cancels a pending sign-in. A browser-return refresh
of the same settings page does not cancel it.

Older app releases do not understand the serialized OAuth credential. To
downgrade, configure a manual HA token again; do not paste the serialized value
into another application as an access token.

## Verification

Automated tests cover PKCE, callback validation, credential origin binding,
renewal, cancellation, manual-token compatibility, and HA connection recovery.
On 2026-11-22, the attached Pixel 10 completed browser sign-in, the native
callback returned successfully, renewable credentials were saved in BridgeThing,
and the Car Thing connected to HA Cloud. A separate renewal request returned
HTTP 200 and its new access token authenticated to HA's API with HTTP 200.
The saved credentials were left unchanged by that renewal test.

With Wi-Fi disabled, Android reported a validated cellular connection. The Car
Thing remained connected to MA through HA Cloud, and a fresh renewal request
and authenticated HA API request both returned HTTP 200. The assigned phone
player was still unavailable; these checks did not start playback.

This verifies login and the renewal endpoint, not native phone audio or the
locked-phone/cold-car startup experience.

## Development Deployment

Copying a new `settings.html` onto an already installed app is not sufficient.
BridgeThing retains the settings hash in its in-memory app registry, and the
companion caches the page using that hash. Reloading the Car Thing browser or
clearing the phone cache does not update the daemon's registry.

A normal bundle installation rescans the registry and announces updated app
metadata. For manual USB file deployment, refresh the daemon's registry and
verify its advertised settings hash against the deployed file. A daemon restart
does this but briefly interrupts Bluetooth, so warn before using it. Do not
uninstall the app, clear its data, or remove pairing to refresh settings.

The phone's visible page must be checked after deployment; a successful build
or copied file alone does not verify that the new sign-in control is available.

Sources: [HA authentication API](https://developers.home-assistant.io/docs/auth_api/),
[BridgeThing settings authorization](https://bridgething.com/docs/settings-pages/).
