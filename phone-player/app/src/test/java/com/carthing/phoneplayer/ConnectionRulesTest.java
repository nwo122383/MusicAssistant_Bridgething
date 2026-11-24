package com.carthing.phoneplayer;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionRulesTest {
    @Test public void acceptsHttpsOrigin() {
        assertEquals("https://example.org", ConnectionRules.origin(" https://example.org/ "));
        assertEquals("https://example.org:8123", ConnectionRules.origin("https://example.org:8123"));
    }
    @Test public void rejectsCredentialAndPathConfusion() {
        for (String value : new String[] { "http://example.org", "https://a@example.org", "https://example.org/path", "https://example.org/?token=secret", "https://example.org/#x", "not-a-url" })
            assertThrows(IllegalArgumentException.class, () -> ConnectionRules.origin(value));
    }
    @Test public void ingressStaysWithinAuthenticatedOrigin() {
        assertEquals("https://example.org/api/hassio_ingress/test/", ConnectionRules.ingress("https://example.org", "/api/hassio_ingress/test"));
        for (String value : new String[] { "https://evil.org/api/hassio_ingress/test", "//evil.org/api/hassio_ingress/test", "/api/hassio_ingress/../outside", "/api/hassio_ingress/%2e%2e/outside", "/api/hassio_ingress/test?token=x", "/api/hassio_ingress/test#x" })
            assertThrows(IllegalArgumentException.class, () -> ConnectionRules.ingress("https://example.org", value));
    }
}
