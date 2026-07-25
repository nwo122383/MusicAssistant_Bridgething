package com.carthing.marelay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothDevice;
import android.content.Context;
import android.content.Intent;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

public final class RelayService extends Service {
    private static final String CHANNEL_ID = "CarThingRelayChannel";
    private static final int NOTIFICATION_ID = 1;

    private PowerManager.WakeLock wakeLock;
    private RfcommRelayClient relayClient;
    private final IBinder binder = new LocalBinder();
    private volatile RfcommRelayClient.Listener activeListener;
    private final Handler reconnectHandler = new Handler(Looper.getMainLooper());
    private BluetoothDevice lastDevice;
    private String lastMassUrl;
    private String lastHaToken;
    private boolean relayEnabled = false;
    private int reconnectAttempts = 0;
    private boolean reconnectScheduled = false;
    private int relayGeneration = 0;

    public final class LocalBinder extends Binder {
        RelayService getService() {
            return RelayService.this;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildNotification("Relay active");
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_STICKY;
    }

    public void setListener(RfcommRelayClient.Listener listener) {
        this.activeListener = listener;
    }

    public void ping() {
        if (relayClient != null) {
            relayClient.ping();
        }
    }

    public void benchmark(int size) {
        if (relayClient != null) {
            relayClient.benchmark(size);
        }
    }

    public void startRelay(BluetoothDevice device, String massUrl, String haToken, RfcommRelayClient.Listener listener) {
        setListener(listener);
        lastDevice = device;
        lastMassUrl = massUrl;
        lastHaToken = haToken;
        relayEnabled = true;
        reconnectAttempts = 0;
        reconnectScheduled = false;
        reconnectHandler.removeCallbacksAndMessages(null);
        openRelay(device, massUrl, haToken);
    }

    private void openRelay(BluetoothDevice device, String massUrl, String haToken) {
        final int generation = ++relayGeneration;
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CarThingRelay::WakeLock");
            wakeLock.acquire();
        }

        if (relayClient != null) {
            relayClient.close();
        }

        RfcommRelayClient.Listener wrappedListener = new RfcommRelayClient.Listener() {
            @Override
            public void onStatus(String status) {
                if (generation != relayGeneration) {
                    return;
                }
                Log.d("MARelay", "Relay status[" + generation + "]: " + status);
                updateNotification(status);
                if (status.contains("Connected to Music Assistant") || status.contains("Remote connection active")) {
                    reconnectAttempts = 0;
                    reconnectScheduled = false;
                    reconnectHandler.removeCallbacksAndMessages(null);
                }
                RfcommRelayClient.Listener l = activeListener;
                if (l != null) {
                    l.onStatus(status);
                }
            }

            @Override
            public void onMessage(String message) {
                if (generation != relayGeneration) {
                    return;
                }
                Log.d("MARelay", "Relay message[" + generation + "]: " + message);
                RfcommRelayClient.Listener l = activeListener;
                if (l != null) {
                    l.onMessage(message);
                }
            }

            @Override
            public void onError(Throwable error) {
                if (generation != relayGeneration) {
                    return;
                }
                Log.w("MARelay", "Relay error[" + generation + "]: " + error.getMessage(), error);
                updateNotification("Error: " + error.getMessage());
                RfcommRelayClient.Listener l = activeListener;
                if (l != null) {
                    l.onError(error);
                }
                scheduleReconnect(error.getMessage());
            }
        };

        relayClient = new RfcommRelayClient(this, android.bluetooth.BluetoothAdapter.getDefaultAdapter(), wrappedListener);
        relayClient.connect(device, massUrl, haToken);
    }

    private void scheduleReconnect(String reason) {
        if (!relayEnabled || lastDevice == null || lastMassUrl == null) {
            return;
        }
        if (reconnectScheduled) {
            Log.d("MARelay", "Reconnect already scheduled; ignoring: " + reason);
            return;
        }
        reconnectScheduled = true;
        reconnectAttempts += 1;
        long delayMs = Math.min(60_000L, 5_000L * reconnectAttempts);
        Log.d("MARelay", "Scheduling reconnect attempt " + reconnectAttempts + " in " + delayMs + "ms: " + reason);
        updateNotification("Relay lost; reconnecting in " + (delayMs / 1000) + "s");
        RfcommRelayClient.Listener l = activeListener;
        if (l != null) {
            l.onMessage("Relay lost: " + reason);
            l.onMessage("Auto-reconnect attempt " + reconnectAttempts + " in " + (delayMs / 1000) + "s");
        }
        reconnectHandler.postDelayed(() -> {
            reconnectScheduled = false;
            if (!relayEnabled || lastDevice == null || lastMassUrl == null) {
                return;
            }
            openRelay(lastDevice, lastMassUrl, lastHaToken);
        }, delayMs);
    }

    public void stopRelay() {
        relayEnabled = false;
        reconnectAttempts = 0;
        reconnectScheduled = false;
        relayGeneration += 1;
        reconnectHandler.removeCallbacksAndMessages(null);
        if (relayClient != null) {
            relayClient.close();
            relayClient = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
        stopForeground(true);
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onDestroy() {
        stopRelay();
        super.onDestroy();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Car Thing MA Relay Service",
                NotificationManager.IMPORTANCE_LOW
        );
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String text) {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, notificationIntent, PendingIntent.FLAG_IMMUTABLE);

        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Car Thing Music Assistant Relay")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(text));
        }
    }
}
