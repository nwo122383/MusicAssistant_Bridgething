package com.carthing.phoneplayer;

import androidx.test.platform.app.InstrumentationRegistry;
import android.content.Context;
import org.junit.Test;
import org.junit.Assume;
import java.io.File;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class PhonePlayerDeviceTest {
    @Test public void encryptedIdentitySurvivesStoreRecreation() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PlayerSecrets first = new PlayerSecrets(context);
        String name = "test.identity.fixture";
        try {
            first.put(name, "persistent-test-identity");
            assertEquals("persistent-test-identity", new PlayerSecrets(context).get(name));
            assertFalse(context.getSharedPreferences("phone_player_secrets", Context.MODE_PRIVATE).getString(name, "").contains("persistent-test-identity"));
        } finally { first.remove(name); }
    }

    @Test public void provisionDevelopmentSession() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File file = new File(context.getFilesDir(), "phone-player-test-session.json");
        Assume.assumeTrue("Private test session not supplied", file.exists());
        try {
            String session = new String(Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8);
            new PlayerSecrets(context).saveHaSession(session);
            String origin = new PlayerSecrets(context).haSession().getString("origin");
            context.getSharedPreferences("player", Context.MODE_PRIVATE).edit().putString("ha_origin", origin).commit();
        } finally { assertTrue(file.delete()); }
    }
}
