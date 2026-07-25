package com.carthing.marelay;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class RelayFrameCodec {
    private static final byte[] MAGIC = "CTMA".getBytes(StandardCharsets.US_ASCII);

    private RelayFrameCodec() {}

    public static RelayFrame read(InputStream input) throws IOException {
        DataInputStream data = new DataInputStream(input);
        byte[] magic = new byte[4];
        data.readFully(magic);
        for (int index = 0; index < MAGIC.length; index++) {
            if (magic[index] != MAGIC[index]) throw new IOException("Invalid relay frame magic");
        }
        int version = data.readUnsignedByte();
        if (version != RelayProtocol.VERSION) throw new IOException("Unsupported relay protocol " + version);
        int type = data.readUnsignedByte();
        int flags = data.readUnsignedShort();
        long requestId = Integer.toUnsignedLong(data.readInt());
        long length = Integer.toUnsignedLong(data.readInt());
        if (length > RelayProtocol.MAX_PAYLOAD) throw new IOException("Relay payload is too large: " + length);
        byte[] payload = new byte[(int) length];
        data.readFully(payload);
        return new RelayFrame(type, flags, requestId, payload);
    }

    public static synchronized void write(OutputStream output, RelayFrame frame) throws IOException {
        if (frame.payload().length > RelayProtocol.MAX_PAYLOAD) {
            throw new IOException("Relay payload is too large: " + frame.payload().length);
        }
        DataOutputStream data = new DataOutputStream(output);
        data.write(MAGIC);
        data.writeByte(RelayProtocol.VERSION);
        data.writeByte(frame.type());
        data.writeShort(frame.flags());
        data.writeInt((int) frame.requestId());
        data.writeInt(frame.payload().length);
        data.write(frame.payload());
        data.flush();
    }
}
