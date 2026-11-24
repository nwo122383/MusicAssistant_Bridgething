package com.carthing.phoneplayer;

import java.net.URI;

final class ConnectionRules {
    static String origin(String input) {
        try {
            URI uri = URI.create(input.trim());
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null ||
                uri.getRawQuery() != null || uri.getRawFragment() != null ||
                !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))) throw new IllegalArgumentException();
            return new URI("https", null, uri.getHost().toLowerCase(java.util.Locale.ROOT), uri.getPort(), null, null, null).toString();
        } catch (Exception error) { throw new IllegalArgumentException("Enter the Home Assistant HTTPS server address"); }
    }

    static String ingress(String origin, String path) {
        try {
            URI base = URI.create(origin(origin));
            URI resolved = base.resolve(path);
            if (!base.getScheme().equals(resolved.getScheme()) || !base.getRawAuthority().equals(resolved.getRawAuthority()) ||
                resolved.getRawQuery() != null || resolved.getRawFragment() != null || resolved.getRawUserInfo() != null ||
                !resolved.getPath().startsWith("/api/hassio_ingress/") ||
                !resolved.getRawPath().equals(resolved.getPath()) || resolved.getPath().contains("/../")) throw new IllegalArgumentException();
            String value = resolved.toString();
            return value.endsWith("/") ? value : value + "/";
        } catch (Exception error) { throw new IllegalArgumentException("Home Assistant returned an invalid Music Assistant route"); }
    }
}
