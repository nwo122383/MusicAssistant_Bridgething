# Car Thing Music Assistant relay protocol

This protocol carries Music Assistant traffic between the Android relay and a
local Car Thing service over an authenticated Bluetooth Classic RFCOMM socket.
It uses a dedicated service so it can coexist with Nocturne's SPP channel.

## Bluetooth service

- Service name: `Car Thing MA Relay`
- UUID: `d32cc560-8385-4197-9c3c-8c017ce2034c`
- RFCOMM channel: `3`
- Authentication: required; authorization: not required

The Car Thing is the RFCOMM server. Android discovers the channel through SDP
and opens an encrypted socket with `createRfcommSocketToServiceRecord`.

## Frame format

All integers use network byte order. The 16-byte header is followed by exactly
`payload_length` bytes.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | ASCII magic `CTMA` |
| 4 | 1 | Protocol version (`1`) |
| 5 | 1 | Message type |
| 6 | 2 | Flags, reserved as zero |
| 8 | 4 | Unsigned request ID |
| 12 | 4 | Unsigned payload length |

The current maximum payload is 1 MiB. Invalid magic, version, or length closes
the connection.

## Prototype message types

| Value | Name | Direction | Payload |
|---:|---|---|---|
| `0x01` | HELLO | Android → Car Thing | UTF-8 JSON capabilities |
| `0x02` | HELLO_ACK | Car Thing → Android | UTF-8 JSON capabilities |
| `0x03` | PING | Android → Car Thing | Arbitrary bytes |
| `0x04` | PONG | Car Thing → Android | Same bytes |
| `0x05` | BENCHMARK | Android → Car Thing | Arbitrary bytes |
| `0x06` | BENCHMARK_ACK | Car Thing → Android | Same bytes |
| `0x7f` | ERROR | Either direction | UTF-8 error message |

The next milestone adds WebSocket text frames, HTTP artwork requests, chunked
binary responses, and connection-state events without changing this header.
