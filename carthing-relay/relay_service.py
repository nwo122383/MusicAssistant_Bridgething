#!/usr/bin/env python3
import asyncio
import json
import logging
import os
import socket
import struct
import sys
import hashlib
import base64
import contextlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "vendor"))

from dbus_next import BusType, Variant
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method

SERVICE_UUID = "d32cc560-8385-4197-9c3c-8c017ce2034c"
PROFILE_PATH = "/com/carthing/ma_relay/profile"
PROFILE_INTERFACE = "org.bluez.Profile1"
HEADER = struct.Struct(">4sBBHII")
MAGIC = b"CTMA"
VERSION = 1
MAX_PAYLOAD = 1024 * 1024

HELLO = 0x01
HELLO_ACK = 0x02
PING = 0x03
PONG = 0x04
BENCHMARK = 0x05
BENCHMARK_ACK = 0x06
WS_TEXT = 0x10
IMAGE_GET = 0x20
IMAGE_DATA = 0x21
ERROR = 0x7F

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("carthing-ma-relay")


class BluetoothSession:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.pending_image_requests = {}  # request_id -> asyncio.Future
        self.active_ws_writer = None
        self.cached_handshake = None


async def close_writer(writer):
    try:
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
    except Exception:
        pass


active_bt_session = None
next_request_id = 1


def get_next_request_id():
    global next_request_id
    rid = next_request_id
    next_request_id += 1
    return rid


def get_websocket_accept(key):
    guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    sha1 = hashlib.sha1((key + guid).encode('utf-8'))
    return base64.b64encode(sha1.digest()).decode('utf-8')


async def read_ws_frame(reader):
    header = await reader.readexactly(2)
    b1, b2 = header[0], header[1]
    fin = b1 & 0x80
    opcode = b1 & 0x0f
    masked = b2 & 0x80
    payload_len = b2 & 0x7f

    if payload_len == 126:
        len_bytes = await reader.readexactly(2)
        payload_len = int.from_bytes(len_bytes, byteorder='big')
    elif payload_len == 127:
        len_bytes = await reader.readexactly(8)
        payload_len = int.from_bytes(len_bytes, byteorder='big')

    if masked:
        masking_key = await reader.readexactly(4)

    payload = await reader.readexactly(payload_len)

    if masked:
        unmasked = bytearray(payload_len)
        for i in range(payload_len):
            unmasked[i] = payload[i] ^ masking_key[i % 4]
        payload = bytes(unmasked)

    return opcode, payload


def make_ws_frame(payload, opcode=1):
    payload_bytes = payload if isinstance(payload, bytes) else payload.encode('utf-8')
    length = len(payload_bytes)

    header = bytearray()
    header.append(0x80 | opcode)

    if length <= 125:
        header.append(length)
    elif length <= 65535:
        header.append(126)
        header.extend(length.to_bytes(2, byteorder='big'))
    else:
        header.append(127)
        header.extend(length.to_bytes(8, byteorder='big'))

    return bytes(header) + payload_bytes


def make_ws_close_frame(code=1013, reason="Android relay is not connected"):
    payload = code.to_bytes(2, byteorder='big') + reason.encode('utf-8')
    return make_ws_frame(payload, opcode=8)


async def read_http_request(reader):
    request_line = await reader.readline()
    if not request_line:
        return None, None, {}
    parts = request_line.decode('utf-8').strip().split(' ', 2)
    if len(parts) < 2:
        return None, None, {}
    method, path = parts[0], parts[1]
    headers = {}
    while True:
        line = await reader.readline()
        if line == b'\r\n' or line == b'\n' or not line:
            break
        header_parts = line.decode('utf-8').strip().split(':', 1)
        if len(header_parts) == 2:
            headers[header_parts[0].strip().lower()] = header_parts[1].strip()
    return method, path, headers


async def read_frame(reader):
    raw = await reader.readexactly(HEADER.size)
    magic, version, message_type, flags, request_id, length = HEADER.unpack(raw)
    if magic != MAGIC:
        raise ValueError("invalid relay magic")
    if version != VERSION:
        raise ValueError("unsupported relay version %s" % version)
    if length > MAX_PAYLOAD:
        raise ValueError("relay payload is too large: %s" % length)
    return message_type, flags, request_id, await reader.readexactly(length)


write_lock = asyncio.Lock()


async def write_frame(writer, message_type, request_id, payload=b"", flags=0):
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("relay payload is too large: %s" % len(payload))
    async with write_lock:
        writer.write(HEADER.pack(MAGIC, VERSION, message_type, flags, request_id, len(payload)))
        writer.write(payload)
        await writer.drain()


async def handle_connection(device, fd):
    global active_bt_session
    relay_socket = socket.socket(fileno=fd)
    relay_socket.setblocking(False)
    bt_reader, bt_writer = await asyncio.open_connection(sock=relay_socket)
    log.info("Android relay connected from %s", device)
    
    session = BluetoothSession(bt_reader, bt_writer)
    active_bt_session = session
    try:
        while True:
            message_type, _flags, request_id, payload = await read_frame(bt_reader)
            if message_type == HELLO:
                response = json.dumps({"service": "carthing-ma-relay", "version": VERSION}).encode()
                await write_frame(bt_writer, HELLO_ACK, request_id, response)
            elif message_type == PING:
                await write_frame(bt_writer, PONG, request_id, payload)
            elif message_type == BENCHMARK:
                await write_frame(bt_writer, BENCHMARK_ACK, request_id, payload)
            elif message_type == WS_TEXT:
                text_peek = payload[:100].decode('utf-8', errors='ignore')
                log.info("Server -> Browser: %s", text_peek)
                if b"server_id" in payload and b"server_version" in payload:
                    session.cached_handshake = payload
                    log.info("Cached server handshake message")
                if session.active_ws_writer:
                    try:
                        session.active_ws_writer.write(make_ws_frame(payload.decode('utf-8')))
                        await session.active_ws_writer.drain()
                    except Exception:
                        log.exception("Failed to write WS frame to browser")
            elif message_type == IMAGE_DATA:
                future = session.pending_image_requests.pop(request_id, None)
                if future and not future.done():
                    future.set_result(payload)
            else:
                await write_frame(bt_writer, ERROR, request_id, b"unsupported prototype message")
    except asyncio.IncompleteReadError:
        log.info("Android relay disconnected: %s", device)
    except Exception:
        log.exception("Relay connection failed for %s", device)
    finally:
        if active_bt_session == session:
            active_bt_session = None
        if session.active_ws_writer:
            await close_writer(session.active_ws_writer)
            session.active_ws_writer = None
        await close_writer(bt_writer)


async def handle_local_client(reader, writer):
    global active_bt_session
    try:
        method, path, headers = await read_http_request(reader)
        if not method:
            await close_writer(writer)
            return

        if method == "GET" and path.startswith("/mass/ws"):
            log.info("Local client requested WS upgrade")
            accept_val = get_websocket_accept(headers.get('sec-websocket-key', ''))
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: {}\r\n\r\n"
            ).format(accept_val).encode('utf-8')
            writer.write(response)
            await writer.drain()

            session = active_bt_session
            if not session:
                log.error("No active Bluetooth session to route WebSocket connection")
                writer.write(make_ws_close_frame())
                await writer.drain()
                await close_writer(writer)
                return

            session.active_ws_writer = writer
            log.info("Local client WebSocket connected")

            if session.cached_handshake:
                log.info("Sending cached server handshake to new local client")
                try:
                    writer.write(make_ws_frame(session.cached_handshake.decode('utf-8')))
                    await writer.drain()
                except Exception:
                    log.exception("Failed to send cached handshake to browser")

            try:
                while True:
                    opcode, payload = await read_ws_frame(reader)
                    if opcode == 8:
                        log.info("Local client WS closed")
                        break
                    if opcode == 1:
                        text_peek = payload[:100].decode('utf-8', errors='ignore')
                        log.info("Browser -> Server: %s", text_peek)
                        if active_bt_session:
                            await write_frame(active_bt_session.writer, WS_TEXT, 0, payload)
            except Exception:
                log.exception("Local WS client connection error")
            finally:
                if session.active_ws_writer == writer:
                    session.active_ws_writer = None
                await close_writer(writer)

        elif method == "GET" and path.startswith("/mass/imageproxy"):
            log.info("Local client requested image: %s", path)
            session = active_bt_session
            if not session:
                log.error("No active Bluetooth session to route image request")
                writer.write(b"HTTP/1.1 503 Service Unavailable\r\n\r\n")
                await writer.drain()
                await close_writer(writer)
                return

            rid = get_next_request_id()
            future = asyncio.get_running_loop().create_future()
            session.pending_image_requests[rid] = future

            try:
                await write_frame(session.writer, IMAGE_GET, rid, path.encode('utf-8'))
                image_bytes = await asyncio.wait_for(future, timeout=15.0)

                response = (
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: image/jpeg\r\n"
                    "Content-Length: {}\r\n"
                    "Connection: close\r\n\r\n"
                ).format(len(image_bytes)).encode('utf-8')
                writer.write(response + image_bytes)
                await writer.drain()
            except Exception as e:
                log.error("Failed to fetch image: %s", e)
                session.pending_image_requests.pop(rid, None)
                writer.write(b"HTTP/1.1 404 Not Found\r\n\r\n")
                await writer.drain()
            finally:
                await close_writer(writer)
        else:
            log.warning("Local client requested unknown path: %s %s", method, path)
            writer.write(b"HTTP/1.1 404 Not Found\r\n\r\n")
            await writer.drain()
            await close_writer(writer)
    except Exception:
        log.exception("Error handling local client")
        await close_writer(writer)


class RelayProfile(ServiceInterface):
    def __init__(self):
        super().__init__(PROFILE_INTERFACE)
        self.connections = {}

    @method()
    def Release(self):
        log.info("BlueZ released the MA relay profile")

    @method()
    def NewConnection(self, device: "o", fd: "h", properties: "a{sv}"):
        del properties
        task = asyncio.create_task(handle_connection(device, fd))
        self.connections[device] = task
        task.add_done_callback(lambda _task: self.connections.pop(device, None))

    @method()
    def RequestDisconnection(self, device: "o"):
        task = self.connections.pop(device, None)
        if task:
            task.cancel()


async def main():
    bus = await MessageBus(bus_type=BusType.SYSTEM, negotiate_unix_fd=True).connect()
    profile = RelayProfile()
    bus.export(PROFILE_PATH, profile)

    introspection = await bus.introspect("org.bluez", "/org/bluez")
    bluez = bus.get_proxy_object("org.bluez", "/org/bluez", introspection)
    manager = bluez.get_interface("org.bluez.ProfileManager1")
    options = {
        "Name": Variant("s", "Car Thing MA Relay"),
        "Role": Variant("s", "server"),
        "Channel": Variant("q", 3),
        "RequireAuthentication": Variant("b", True),
        "RequireAuthorization": Variant("b", False),
        "AutoConnect": Variant("b", False),
    }
    await manager.call_register_profile(PROFILE_PATH, SERVICE_UUID, options)
    log.info("MA relay listening on RFCOMM channel 3 (%s)", SERVICE_UUID)
    
    # Start local TCP server on 127.0.0.1:4173
    tcp_server = await asyncio.start_server(handle_local_client, "127.0.0.1", 4173)
    log.info("Local TCP proxy listening on 127.0.0.1:4173")

    await bus.wait_for_disconnect()


if __name__ == "__main__":
    asyncio.run(main())
