package com.carthing.phoneplayer;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.util.Log;

public final class PlayerService extends Service {
    private static final String CHANNEL = "phone_player_connection";
    private static final int NOTIFICATION = 1;
    static final String GONE = "com.carthing.phoneplayer.DEVICE_GONE";
    private static final String RECONNECT = "com.carthing.phoneplayer.RECONNECT";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private NativePhonePlayer connection;
    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private long connectionEpoch;
    private boolean restarting, destroyed;
    private final PlaybackPolicy playback = new PlaybackPolicy();
    private final Runnable checkRuntime = this::applyRuntimePolicy;

    static void start(Context context) {
        if (context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            status(context, "Nearby Devices permission is required for automatic startup");
            return;
        }
        try { context.startForegroundService(new Intent(context, PlayerService.class)); }
        catch (RuntimeException error) { status(context, "Android blocked background startup; open the helper to reconnect"); }
    }

    static void reconnect(Context context) {
        if (context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            status(context, "Sign-in saved; grant Nearby Devices permission to start phone audio");
            return;
        }
        try { context.startForegroundService(new Intent(context, PlayerService.class).setAction(RECONNECT)); }
        catch (RuntimeException error) { status(context, "Open CarThing Phone Player to start phone audio"); }
    }

    static void status(Context context, String message) {
        Log.i("CarThingPhonePlayer", message);
        context.getSharedPreferences("player", MODE_PRIVATE).edit().putString("status", message).apply();
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Phone audio connection", NotificationManager.IMPORTANCE_LOW));
        mediaSession = new MediaSession(this, "CarThing Phone Player");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { if (connection != null) connection.command("play"); }
            @Override public void onPause() { if (connection != null) connection.command("pause"); }
            @Override public void onStop() { if (connection != null) connection.command("stop"); }
        });
        mediaSession.setActive(true);
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CarThingPhonePlayer:audio");
        wakeLock.setReferenceCounted(false);
        startForeground(NOTIFICATION, notification("Preparing phone audio"),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        getSharedPreferences("player", MODE_PRIVATE).edit().putBoolean("running", true).putBoolean("phone_ready", false).apply();
    }

    private void connect() {
        final long epoch = ++connectionEpoch;
        restarting = false;
        playback.playback(false, false, true, SystemClock.elapsedRealtime());
        applyRuntimePolicy();
        connection = new NativePhonePlayer(this, update -> handler.post(() -> {
            if (destroyed || epoch != connectionEpoch) return;
            status(this, update.getMessage());
            getSharedPreferences("player", MODE_PRIVATE).edit().putBoolean("phone_ready", update.getReady())
                .putBoolean("audio_playing", update.getPlaying()).putBoolean("audio_buffering", update.getBuffering())
                .putBoolean("audio_recovering", update.getRecovering()).putBoolean("audio_starved", update.getStarved()).apply();
            Log.i("CarThingPhonePlayer", "Audio state: playing=" + update.getPlaying() + " buffering=" + update.getBuffering() +
                " recovering=" + update.getRecovering() + " starved=" + update.getStarved());
            playback.playback(update.getPlaying(), update.getBuffering(), update.getRecovering(), SystemClock.elapsedRealtime());
            applyRuntimePolicy();
            int state = update.getPlaying() ? PlaybackState.STATE_PLAYING :
                update.getBuffering() || update.getRecovering() ? PlaybackState.STATE_BUFFERING : PlaybackState.STATE_PAUSED;
            mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_STOP | PlaybackState.ACTION_PLAY_PAUSE)
                .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, update.getPlaying() ? 1 : 0).build());
            getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(update.getMessage()));
        }));
        connection.start();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && GONE.equals(intent.getAction())) {
            playback.disappeared(SystemClock.elapsedRealtime());
            applyRuntimePolicy();
            return START_NOT_STICKY;
        }
        playback.appeared();
        if (connection == null && !restarting) connect();
        else if (intent != null && RECONNECT.equals(intent.getAction())) {
            if (!restarting && connection != null) {
                restarting = true;
                final long epoch = ++connectionEpoch;
                NativePhonePlayer old = connection;
                connection = null;
                old.stop(() -> handler.post(() -> {
                    if (!destroyed && epoch == connectionEpoch) connect();
                }));
            }
        }
        applyRuntimePolicy();
        return START_NOT_STICKY;
    }

    private void applyRuntimePolicy() {
        if (destroyed) return;
        handler.removeCallbacks(checkRuntime);
        long now = SystemClock.elapsedRealtime();
        boolean needed = playback.needsWakeLock(now);
        if (needed && !wakeLock.isHeld()) {
            wakeLock.acquire();
            Log.i("CarThingPhonePlayer", "Audio CPU wake lock acquired");
        } else if (!needed && wakeLock.isHeld()) {
            wakeLock.release();
            Log.i("CarThingPhonePlayer", "Audio CPU wake lock released");
        }
        getSharedPreferences("player", MODE_PRIVATE).edit().putBoolean("wake_lock_held", wakeLock.isHeld())
            .putBoolean("control_present", playback.isPresent()).apply();
        if (playback.shouldStop(now)) {
            Log.i("CarThingPhonePlayer", "Car Thing absent and phone audio idle; stopping receiver");
            stopSelf();
            return;
        }
        long next = playback.nextCheckAt(now);
        if (next != Long.MAX_VALUE) handler.postDelayed(checkRuntime, Math.max(1, next - now));
    }

    private Notification notification(String message) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("CarThing Phone Player").setContentText(message).setContentIntent(open)
            .setStyle(new Notification.MediaStyle().setMediaSession(mediaSession.getSessionToken())).setOngoing(true).build();
    }

    @Override public void onDestroy() {
        destroyed = true;
        connectionEpoch++;
        handler.removeCallbacksAndMessages(null);
        if (connection != null) connection.stop();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); }
        getSharedPreferences("player", MODE_PRIVATE).edit().putBoolean("running", false).putBoolean("phone_ready", false)
            .putBoolean("wake_lock_held", false).putBoolean("audio_playing", false).putBoolean("audio_buffering", false)
            .putBoolean("audio_recovering", false).putBoolean("audio_starved", false).apply();
        status(this, "Phone player stopped");
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
