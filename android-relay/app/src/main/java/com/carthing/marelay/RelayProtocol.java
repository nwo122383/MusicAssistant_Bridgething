package com.carthing.marelay;

import java.util.UUID;

public final class RelayProtocol {
    private RelayProtocol() {}

    public static final UUID SERVICE_UUID =
            UUID.fromString("d32cc560-8385-4197-9c3c-8c017ce2034c");
    public static final int VERSION = 1;
    public static final int MAX_PAYLOAD = 1024 * 1024;

    public static final int HELLO = 0x01;
    public static final int HELLO_ACK = 0x02;
    public static final int PING = 0x03;
    public static final int PONG = 0x04;
    public static final int BENCHMARK = 0x05;
    public static final int BENCHMARK_ACK = 0x06;
    public static final int WS_TEXT = 0x10;
    public static final int IMAGE_GET = 0x20;
    public static final int IMAGE_DATA = 0x21;
    public static final int ERROR = 0x7f;
}
