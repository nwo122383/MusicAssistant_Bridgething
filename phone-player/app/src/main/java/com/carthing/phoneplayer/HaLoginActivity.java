package com.carthing.phoneplayer;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import okhttp3.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public final class HaLoginActivity extends Activity {
    private WebView browser;
    private TextView label;
    private String origin, state, verifier;
    private boolean exchanging;
    private volatile boolean cancelled;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(30, TimeUnit.SECONDS).build();

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        try { origin = ConnectionRules.origin(getIntent().getStringExtra("server")); }
        catch (Exception error) { finish(); return; }
        state = saved == null ? random() : saved.getString("oauth_state");
        verifier = saved == null ? random() : saved.getString("oauth_verifier");
        if (state == null || verifier == null) { finish(); return; }
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        label = new TextView(this); label.setTextColor(Color.WHITE); label.setPadding(20, 20, 20, 20);
        label.setText("Home Assistant sign-in\n" + Uri.parse(origin).getHost()); layout.addView(label);
        browser = new WebView(this);
        browser.getSettings().setJavaScriptEnabled(true);
        browser.getSettings().setDomStorageEnabled(true);
        browser.getSettings().setAllowFileAccess(false);
        browser.getSettings().setAllowContentAccess(false);
        browser.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        browser.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri uri = request.getUrl();
                if (isCallback(uri)) { complete(uri); return true; }
                if (origin.equals(uri.getScheme() + "://" + uri.getEncodedAuthority())) return false;
                label.setText("Sign-in left the Home Assistant server. Close this page and try again.");
                return true;
            }
        });
        layout.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(layout);
        if (saved != null && browser.restoreState(saved) != null) return;
        try {
            String challenge = base64(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
            Uri url = Uri.parse(origin + "/auth/authorize").buildUpon().appendQueryParameter("client_id", PlayerSecrets.HA_CLIENT_ID)
                .appendQueryParameter("redirect_uri", PlayerSecrets.HA_REDIRECT).appendQueryParameter("response_type", "code")
                .appendQueryParameter("state", state).appendQueryParameter("code_challenge", challenge)
                .appendQueryParameter("code_challenge_method", "S256").build();
            browser.loadUrl(url.toString());
        } catch (Exception error) { label.setText("Unable to start secure sign-in"); }
    }

    private boolean isCallback(Uri uri) {
        return "https".equals(uri.getScheme()) && "bridgething.com".equals(uri.getEncodedAuthority()) &&
            "/oauth/callback".equals(uri.getPath()) && uri.getFragment() == null;
    }

    private void complete(Uri uri) {
        if (exchanging || cancelled) return;
        if (uri.getQueryParameters("state").size() != 1 ||
            !MessageDigest.isEqual(state.getBytes(StandardCharsets.US_ASCII), String.valueOf(uri.getQueryParameter("state")).getBytes(StandardCharsets.US_ASCII)) ||
            uri.getQueryParameters("code").size() != 1 || uri.getQueryParameter("code").isEmpty() || uri.getQueryParameter("error") != null) {
            label.setText("Home Assistant sign-in could not be verified. Close this page and try again."); return;
        }
        exchanging = true; browser.setVisibility(WebView.GONE); label.setText("Completing Home Assistant sign-in");
        String code = uri.getQueryParameter("code");
        executor.execute(() -> {
            try {
                FormBody form = new FormBody.Builder().add("grant_type", "authorization_code").add("code", code)
                    .add("client_id", PlayerSecrets.HA_CLIENT_ID).add("redirect_uri", PlayerSecrets.HA_REDIRECT)
                    .add("code_verifier", verifier).build();
                try (Response response = http.newCall(new Request.Builder().url(origin + "/auth/token").post(form).build()).execute()) {
                    if (!response.isSuccessful()) throw new IllegalStateException();
                    JSONObject token = new JSONObject(response.body().string());
                    long ttl = token.getLong("expires_in");
                    if (ttl <= 0 || ttl > 86_400) throw new IllegalStateException();
                    JSONObject session = new JSONObject().put("origin", origin).put("accessToken", token.getString("access_token"))
                        .put("refreshToken", token.getString("refresh_token")).put("expiresAt", System.currentTimeMillis() + ttl * 1000);
                    if (cancelled) return;
                    new PlayerSecrets(this).saveHaSession("ha-oauth-v1:" + session);
                    getSharedPreferences("player", MODE_PRIVATE).edit().putString("ha_origin", origin).apply();
                    runOnUiThread(() -> {
                        if (cancelled) return;
                        PlayerService.status(this, "Home Assistant sign-in saved");
                        PlayerService.reconnect(this); setResult(RESULT_OK); finish();
                    });
                }
            } catch (Exception error) { runOnUiThread(() -> { if (!cancelled) label.setText("Home Assistant sign-in failed. Close this page and try again."); }); }
        });
    }

    private static String base64(byte[] bytes) { return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP); }
    private static String random() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return base64(bytes); }
    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out); out.putString("oauth_state", state); out.putString("oauth_verifier", verifier);
        if (browser != null && !exchanging) browser.saveState(out);
    }
    @Override protected void onDestroy() {
        cancelled = true; http.dispatcher().cancelAll(); executor.shutdownNow();
        if (browser != null) { browser.stopLoading(); browser.destroy(); }
        super.onDestroy();
    }
}
