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
import android.util.Log;

public final class PlayerService extends Service {
    private static final String CHANNEL = "phone_player_connection";
    private static final int NOTIFICATION = 1;
    static final String GONE = "com.carthing.phoneplayer.DEVICE_GONE";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private MaConnection connection;
    private final Runnable stopLater = this::stopSelf;

    static void start(Context context) {
        if (context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            status(context, "Nearby Devices permission is required for automatic startup");
            return;
        }
        try { context.startForegroundService(new Intent(context, PlayerService.class)); }
        catch (RuntimeException error) { status(context, "Android blocked background startup; open the helper to reconnect"); }
    }

    static void status(Context context, String message) {
        Log.i("CarThingPhonePlayer", message);
        context.getSharedPreferences("player", MODE_PRIVATE).edit().putString("status", message).apply();
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Phone audio connection", NotificationManager.IMPORTANCE_LOW));
        startForeground(NOTIFICATION, notification("Preparing phone audio"), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        connection = new MaConnection(this, message -> {
            status(this, message);
            manager.notify(NOTIFICATION, notification(message));
        });
        getSharedPreferences("player", MODE_PRIVATE).edit().putBoolean("running", true).apply();
        connection.start();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        handler.removeCallbacks(stopLater);
        if (intent != null && GONE.equals(intent.getAction())) handler.postDelayed(stopLater, 15_000);
        return START_NOT_STICKY;
    }

    private Notification notification(String message) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("CarThing Phone Player").setContentText(message).setContentIntent(open).setOngoing(true).build();
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (connection != null) connection.stop();
        getSharedPreferences("player", MODE_PRIVATE).edit().putBoolean("running", false).apply();
        status(this, "Phone player helper stopped");
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
