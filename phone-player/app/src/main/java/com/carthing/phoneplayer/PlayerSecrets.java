package com.carthing.phoneplayer;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class PlayerSecrets {
    static final String HA_CLIENT_ID = "https://bridgething.com/";
    static final String HA_REDIRECT = "https://bridgething.com/oauth/callback";
    private static final String KEY = "carthing.phoneplayer.v1";
    private static final String PREFIX = "ha-oauth-v1:";
    private final SharedPreferences prefs;

    PlayerSecrets(Context context) { prefs = context.getSharedPreferences("phone_player_secrets", Context.MODE_PRIVATE); }

    synchronized String get(String name) {
        String packed = prefs.getString(name, null);
        if (packed == null) return null;
        try {
            String[] parts = packed.split("\\.", -1);
            if (parts.length != 2) throw new IllegalStateException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception error) { throw new IllegalStateException("Saved phone-player credentials cannot be read; sign in again"); }
    }

    synchronized void put(String name, String value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
                Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            // Identity must reach disk before any connection can advertise it.
            if (!prefs.edit().putString(name, packed).commit()) throw new IllegalStateException();
        } catch (Exception error) { throw new IllegalStateException("Phone-player credentials could not be saved"); }
    }

    synchronized void remove(String name) {
        if (!prefs.edit().remove(name).commit()) throw new IllegalStateException("Phone-player credentials could not be removed");
    }

    synchronized void verifyIdentityStorage() {
        for (String name : prefs.getAll().keySet()) if (name.startsWith("sendspin.")) get(name);
    }

    void saveHaSession(String packed) {
        try {
            if (!packed.startsWith(PREFIX)) throw new IllegalArgumentException();
            JSONObject session = new JSONObject(packed.substring(PREFIX.length()));
            String origin = ConnectionRules.origin(session.getString("origin"));
            if (!origin.equals(session.getString("origin")) || session.getString("accessToken").isEmpty() ||
                session.getString("refreshToken").isEmpty() || session.getLong("expiresAt") <= 0) throw new IllegalArgumentException();
            put("ha_session", packed);
        } catch (Exception error) { throw new IllegalArgumentException("Home Assistant sign-in is invalid"); }
    }

    JSONObject haSession() {
        String packed = get("ha_session");
        if (packed == null) throw new IllegalStateException("Sign in to Home Assistant in CarThing Phone Player");
        try { return new JSONObject(packed.substring(PREFIX.length())); }
        catch (Exception error) { throw new IllegalStateException("Sign in to Home Assistant again"); }
    }

    private static synchronized SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY, null)).getSecretKey();
        if (!create) throw new IllegalStateException();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
