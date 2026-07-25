package com.carthing.marelay;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public final class RelayFrameCodecTest {
    @Test
    public void roundTripsFrame() throws Exception {
        byte[] payload = "hello".getBytes(StandardCharsets.UTF_8);
        RelayFrame expected = new RelayFrame(RelayProtocol.PING, 0, 42, payload);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        RelayFrameCodec.write(output, expected);

        RelayFrame actual = RelayFrameCodec.read(new ByteArrayInputStream(output.toByteArray()));
        assertEquals(expected.type(), actual.type());
        assertEquals(expected.flags(), actual.flags());
        assertEquals(expected.requestId(), actual.requestId());
        assertArrayEquals(expected.payload(), actual.payload());
    }
}
