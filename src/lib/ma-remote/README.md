# Music Assistant Remote Transport

Vendored from `music-assistant/frontend`, revision
`565b515dcbe69c56f6b8b4644c63602dd5b890b2`, files in
`src/plugins/remote/`. Licensed under Apache-2.0; see LICENSE.

Source: https://github.com/music-assistant/frontend/tree/565b515dcbe69c56f6b8b4644c63602dd5b890b2/src/plugins/remote

Local adaptations: TCP-only TURN relay selection for BridgeThing's SOCKS proxy,
connection cancellation, and disabling independent signaling retries. The app
owns reconnection so Bluetooth recovery cannot create competing sessions.
