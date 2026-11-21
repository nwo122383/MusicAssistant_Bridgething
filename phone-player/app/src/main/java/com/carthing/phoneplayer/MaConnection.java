package com.carthing.phoneplayer;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.media.browse.MediaBrowser;
import android.service.media.MediaBrowserService;
import android.media.session.MediaController;
import android.os.Handler;
import android.os.Looper;
import java.util.List;
import java.util.function.Consumer;

final class MaConnection {
    static final String PACKAGE = "io.music_assistant.client";
    private final Context context;
    private final Consumer<String> status;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaBrowser browser;
    private MediaController controller;
    private int generation;
    private int retryMs = 1000;
    private boolean stopped;

    MaConnection(Context context, Consumer<String> status) {
        this.context = context;
        this.status = status;
    }

    void start() { stopped = false; connect(); }

    void stop() {
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        release();
    }

    private void release() {
        generation++;
        if (controller != null) controller.unregisterCallback(controllerCallback);
        controller = null;
        if (browser != null) browser.disconnect();
        browser = null;
    }

    private void retry(String message) {
        if (stopped) return;
        status.accept(message);
        handler.removeCallbacksAndMessages(null);
        release();
        handler.postDelayed(this::connect, retryMs);
        retryMs = Math.min(10_000, retryMs * 2);
    }

    private final MediaController.Callback controllerCallback = new MediaController.Callback() {
        @Override public void onSessionDestroyed() { retry("Music Assistant media session ended; retrying"); }
    };

    private void connect() {
        if (stopped) return;
        release();
        final int epoch = generation;
        List<ResolveInfo> services = context.getPackageManager().queryIntentServices(
            new Intent(MediaBrowserService.SERVICE_INTERFACE).setPackage(PACKAGE), 0);
        ResolveInfo service = services.stream().filter(info -> info.serviceInfo.exported).findFirst().orElse(null);
        if (service == null) { status.accept("Music Assistant media service is not installed"); return; }
        status.accept("Connecting to Music Assistant media service");
        browser = new MediaBrowser(context, new ComponentName(service.serviceInfo.packageName, service.serviceInfo.name),
            new MediaBrowser.ConnectionCallback() {
                @Override public void onConnected() {
                    if (stopped || epoch != generation) return;
                    handler.removeCallbacksAndMessages(null);
                    retryMs = 1000;
                    controller = new MediaController(context, browser.getSessionToken());
                    controller.registerCallback(controllerCallback, handler);
                    status.accept("Music Assistant media service connected");
                    browser.subscribe(browser.getRoot(), new MediaBrowser.SubscriptionCallback() {
                        @Override public void onChildrenLoaded(String parent, List<MediaBrowser.MediaItem> children) {
                            if (stopped || epoch != generation) return;
                            boolean disabled = children.stream().anyMatch(item -> "auto_lib_local_player_off".equals(item.getMediaId()));
                            status.accept(disabled ? "Enable the local Sendspin player in Music Assistant once" : "Music Assistant media service connected");
                        }
                        @Override public void onError(String parent) {
                            if (!stopped && epoch == generation) status.accept("Media service connected; waiting for Music Assistant");
                        }
                    });
                }
                @Override public void onConnectionSuspended() {
                    if (epoch == generation) retry("Media service suspended; retrying");
                }
                @Override public void onConnectionFailed() {
                    if (epoch == generation) retry("Music Assistant refused the media connection; retrying");
                }
            }, null);
        try {
            browser.connect();
            handler.postDelayed(() -> { if (epoch == generation) retry("Media service connection timed out; retrying"); }, 15_000);
        } catch (RuntimeException error) {
            retry("Unable to bind Music Assistant media service; retrying");
        }
    }
}
