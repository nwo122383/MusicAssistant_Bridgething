package com.carthing.marelay;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.os.IBinder;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public final class MainActivity extends Activity implements RfcommRelayClient.Listener {
    private static final int BLUETOOTH_PERMISSION_REQUEST = 100;

    private BluetoothAdapter adapter;
    private RelayService relayService;
    private boolean isBound = false;
    private final List<BluetoothDevice> devices = new ArrayList<>();
    private Spinner deviceSpinner;
    private EditText serverUrlInput;
    private EditText haTokenInput;
    private TextView statusView;
    private TextView logView;

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName className, IBinder service) {
            RelayService.LocalBinder binder = (RelayService.LocalBinder) service;
            relayService = binder.getService();
            isBound = true;
            relayService.setListener(MainActivity.this);
            onStatus("Service connected & bound");
        }

        @Override
        public void onServiceDisconnected(ComponentName arg0) {
            isBound = false;
            relayService = null;
            onStatus("Service disconnected");
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        adapter = manager == null ? null : manager.getAdapter();
        
        // Start and bind the background foreground service
        Intent intent = new Intent(this, RelayService.class);
        startForegroundService(intent);
        bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE);

        buildUi();

        String[] permissions = new String[]{
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
        };
        boolean needRequest = false;
        for (String p : permissions) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                needRequest = true;
                break;
            }
        }
        if (needRequest) {
            requestPermissions(permissions, BLUETOOTH_PERMISSION_REQUEST);
        } else {
            loadBondedDevices();
        }
    }

    private void buildUi() {
        int padding = dp(20);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(padding, padding, padding, padding);
        content.setBackgroundColor(Color.rgb(9, 11, 15));

        TextView heading = text("Car Thing MA Relay", 26, Color.WHITE);
        content.addView(heading, matchWrap());

        statusView = text("Waiting for service binding", 16, Color.rgb(101, 230, 167));
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.setMargins(0, dp(8), 0, dp(18));
        content.addView(statusView, statusParams);

        deviceSpinner = new Spinner(this);
        content.addView(deviceSpinner, matchWrap());

        serverUrlInput = new EditText(this);
        serverUrlInput.setHint("Music Assistant URL (e.g. http://192.168.1.50:8095)");
        serverUrlInput.setTextColor(Color.WHITE);
        serverUrlInput.setHintTextColor(Color.GRAY);
        SharedPreferences prefs = getPreferences(MODE_PRIVATE);
        serverUrlInput.setText(prefs.getString("mass_url", "http://192.168.1.50:8095"));
        LinearLayout.LayoutParams inputParams = matchWrap();
        inputParams.setMargins(0, dp(10), 0, 0);
        content.addView(serverUrlInput, inputParams);

        haTokenInput = new EditText(this);
        haTokenInput.setHint("HA Token (optional for remote/Nabu Casa)");
        haTokenInput.setTextColor(Color.WHITE);
        haTokenInput.setHintTextColor(Color.GRAY);
        haTokenInput.setText(prefs.getString("ha_token", ""));
        LinearLayout.LayoutParams haParams = matchWrap();
        haParams.setMargins(0, dp(8), 0, 0);
        content.addView(haTokenInput, haParams);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        Button connect = button("Connect");
        Button ping = button("Ping");
        Button benchmark = button("64 KiB test");
        buttons.addView(connect, weighted());
        buttons.addView(ping, weighted());
        buttons.addView(benchmark, weighted());
        LinearLayout.LayoutParams buttonsParams = matchWrap();
        buttonsParams.setMargins(0, dp(14), 0, dp(14));
        content.addView(buttons, buttonsParams);

        logView = text("", 14, Color.LTGRAY);
        logView.setTextIsSelectable(true);
        ScrollView logScroll = new ScrollView(this);
        logScroll.addView(logView, matchWrap());
        content.addView(logScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        connect.setOnClickListener(view -> connectSelected());
        ping.setOnClickListener(view -> {
            if (isBound && relayService != null) {
                relayService.ping();
            } else {
                onMessage("Relay service is not bound");
            }
        });
        benchmark.setOnClickListener(view -> {
            if (isBound && relayService != null) {
                relayService.benchmark(64 * 1024);
            } else {
                onMessage("Relay service is not bound");
            }
        });
        setContentView(content);
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        return button;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams weighted() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @SuppressWarnings("MissingPermission")
    private void loadBondedDevices() {
        devices.clear();
        if (adapter == null) {
            onStatus("Bluetooth is unavailable");
            return;
        }
        devices.addAll(adapter.getBondedDevices());
        devices.sort(Comparator.comparing(device -> {
            String name = device.getName();
            return name == null ? device.getAddress() : name;
        }));
        List<String> labels = new ArrayList<>();
        int nocturneIndex = -1;
        for (int index = 0; index < devices.size(); index++) {
            BluetoothDevice device = devices.get(index);
            String name = device.getName() == null ? "Unknown" : device.getName();
            labels.add(name + " — " + device.getAddress());
            if (name.toLowerCase().contains("nocturne")) nocturneIndex = index;
        }
        deviceSpinner.setAdapter(new ArrayAdapter<>(
                this, android.R.layout.simple_spinner_dropdown_item, labels));
        if (nocturneIndex >= 0) deviceSpinner.setSelection(nocturneIndex);
        onStatus(labels.isEmpty() ? "Pair Nocturne first" : "Select the paired Car Thing");
    }

    private void connectSelected() {
        int index = deviceSpinner.getSelectedItemPosition();
        if (index < 0 || index >= devices.size()) {
            onMessage("No paired Bluetooth device is selected");
            return;
        }
        String url = serverUrlInput.getText().toString().trim();
        if (url.isEmpty()) {
            onMessage("Please enter the Music Assistant URL");
            return;
        }
        String haToken = haTokenInput.getText().toString().trim();
        getPreferences(MODE_PRIVATE).edit()
            .putString("mass_url", url)
            .putString("ha_token", haToken)
            .apply();

        if (isBound && relayService != null) {
            relayService.startRelay(devices.get(index), url, haToken, this);
        } else {
            onMessage("Relay service is not bound");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == BLUETOOTH_PERMISSION_REQUEST) {
            boolean allGranted = true;
            for (int result : grantResults) {
                if (result != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (allGranted) {
                loadBondedDevices();
            } else {
                onStatus("Nearby devices permission is required");
            }
        }
    }

    @Override
    public void onStatus(String status) {
        runOnUiThread(() -> statusView.setText(status));
    }

    @Override
    public void onMessage(String message) {
        runOnUiThread(() -> logView.append(message + "\n"));
    }

    @Override
    public void onError(Throwable error) {
        onStatus("Relay connection failed");
        onMessage(error.getClass().getSimpleName() + ": " + error.getMessage());
    }

    @Override
    protected void onDestroy() {
        if (isBound) {
            if (relayService != null) {
                relayService.setListener(null);
            }
            unbindService(serviceConnection);
            isBound = false;
        }
        super.onDestroy();
    }
}
