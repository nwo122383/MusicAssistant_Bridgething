package com.carthing.marelay;

public record RelayFrame(int type, int flags, long requestId, byte[] payload) {}
