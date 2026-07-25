import asyncio
import unittest

from relay_service import BENCHMARK, BENCHMARK_ACK, HEADER, MAGIC, VERSION, read_frame, write_frame


class BufferWriter:
    def __init__(self):
        self.buffer = bytearray()

    def write(self, data):
        self.buffer.extend(data)

    async def drain(self):
        return None


class ProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_frame_round_trip(self):
        writer = BufferWriter()
        await write_frame(writer, BENCHMARK, 42, b"hello")
        reader = asyncio.StreamReader()
        reader.feed_data(bytes(writer.buffer))
        reader.feed_eof()
        message_type, flags, request_id, payload = await read_frame(reader)
        self.assertEqual(BENCHMARK, message_type)
        self.assertEqual(0, flags)
        self.assertEqual(42, request_id)
        self.assertEqual(b"hello", payload)

    def test_header_is_sixteen_bytes(self):
        self.assertEqual(16, HEADER.size)
        self.assertEqual(MAGIC, b"CTMA")
        self.assertEqual(1, VERSION)
        self.assertEqual(6, BENCHMARK_ACK)


if __name__ == "__main__":
    unittest.main()
