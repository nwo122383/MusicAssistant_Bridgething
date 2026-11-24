# Sendspin Engine

The source directories in this module are copied without modification from
`music-assistant/mobile-app`, release `sendspin-v0.1.0`, commit
`7ef162da76bee24656cc5145f40ade2fdec72a27`:

https://github.com/music-assistant/mobile-app/tree/7ef162da76bee24656cc5145f40ade2fdec72a27/sendspin-kmp

Copyright remains with the upstream authors. See `LICENSE` (Apache-2.0).
Only the Gradle integration is local, targeting the companion's existing
Android SDK/toolchain without the upstream UI or iOS targets. This source copy
avoids requiring community builders to obtain a GitHub Packages access token.

Persistent player identity, encrypted pairing, audio decoding, buffering, and
clock synchronization are provided by this engine, not reimplemented here.
