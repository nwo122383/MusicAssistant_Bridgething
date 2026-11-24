package com.carthing.phoneplayer;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.companion.AssociationInfo;
import android.companion.AssociationRequest;
import android.companion.BluetoothDeviceFilter;
import android.companion.CompanionDeviceManager;
import android.companion.ObservingDevicePresenceRequest;
import android.content.Intent;
import android.content.IntentSender;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.EditText;
import android.text.InputType;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public final class MainActivity extends Activity {
    private TextView status;
    private Spinner devices;
    private SharedPreferences preferences;
    private EditText server, playerName;
    private final List<BluetoothDevice> paired = new ArrayList<>();
    private final SharedPreferences.OnSharedPreferenceChangeListener changed = (prefs, key) -> refreshStatus();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("player", MODE_PRIVATE);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding * 2, padding, padding);
        layout.setBackgroundColor(Color.rgb(17, 19, 21));
        TextView title = new TextView(this);
        title.setText("CarThing Phone Player"); title.setTextSize(24); title.setTextColor(Color.WHITE);
        layout.addView(title);
        status = new TextView(this); status.setTextSize(16); status.setTextColor(Color.LTGRAY);
        layout.addView(status);
        server = new EditText(this); server.setHint("Home Assistant remote HTTPS URL");
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(preferences.getString("ha_origin", "")); layout.addView(server);
        addButton(layout, "Sign in to Home Assistant", () -> {
            try {
                String origin = ConnectionRules.origin(server.getText().toString());
                saveName();
                startActivity(new Intent(this, HaLoginActivity.class).putExtra("server", origin));
            } catch (IllegalArgumentException error) { PlayerService.status(this, error.getMessage()); }
        });
        playerName = new EditText(this); playerName.setHint("Player name");
        playerName.setSingleLine(true); playerName.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(64) });
        playerName.setText(preferences.getString("player_name", "CarThing Phone")); layout.addView(playerName);
        addButton(layout, "Grant permissions", this::permissions);
        devices = new Spinner(this);
        layout.addView(devices);
        addButton(layout, "Enable automatic startup", this::associate);
        addButton(layout, "Connect phone player", () -> {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) permissions();
            else { saveName(); PlayerService.reconnect(this); }
        });
        addButton(layout, "Stop phone player", () -> stopService(new Intent(this, PlayerService.class)));
        addButton(layout, "Disable automatic startup", this::disableAutomatic);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(layout);
        setContentView(scroll);
        loadDevices();
        refreshStatus();
    }

    private void addButton(LinearLayout layout, String title, Runnable action) {
        Button button = new Button(this); button.setText(title); button.setOnClickListener(view -> action.run()); layout.addView(button);
    }

    private void refreshStatus() {
        if (status == null) return;
        status.setText(preferences.getString("status", "Ready") + "\nAutomatic startup: " +
            (preferences.getBoolean("automatic", false) ? "Enabled" : "Off") + "\n" +
            (preferences.getBoolean("phone_ready", false) ? "Speaker: Available" : "Speaker: Not ready"));
    }

    private void saveName() {
        String name = playerName.getText().toString().trim();
        preferences.edit().putString("player_name", name.isEmpty() ? "CarThing Phone" : name).apply();
    }

    private void permissions() {
        List<String> wanted = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) wanted.add(Manifest.permission.BLUETOOTH_CONNECT);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) wanted.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!wanted.isEmpty()) requestPermissions(wanted.toArray(new String[0]), 1);
        else loadDevices();
    }

    private void loadDevices() {
        paired.clear();
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) {
            BluetoothManager manager = getSystemService(BluetoothManager.class);
            if (manager != null && manager.getAdapter() != null) paired.addAll(manager.getAdapter().getBondedDevices());
            paired.sort(Comparator.comparing(device -> device.getName() == null ? "" : device.getName()));
        }
        List<String> names = new ArrayList<>();
        names.add(paired.isEmpty() ? "No paired devices available" : "Select Car Thing");
        for (BluetoothDevice device : paired) names.add(device.getName() == null ? "Unnamed Bluetooth device" : device.getName());
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names);
        devices.setAdapter(adapter);
        String address = preferences.getString("address", "");
        for (int i = 0; i < paired.size(); i++) if (paired.get(i).getAddress().equals(address)) devices.setSelection(i + 1);
    }

    private void associate() {
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) { permissions(); return; }
        if (paired.isEmpty()) { PlayerService.status(this, "Pair the Car Thing in BridgeThing first"); return; }
        if (devices.getSelectedItemPosition() < 1) { PlayerService.status(this, "No Car Thing selected"); return; }
        BluetoothDevice selected = paired.get(devices.getSelectedItemPosition() - 1);
        CompanionDeviceManager manager = getSystemService(CompanionDeviceManager.class);
        if (Build.VERSION.SDK_INT >= 33) {
            AssociationInfo existing = manager.getMyAssociations().stream().filter(info -> info.getDeviceMacAddress() != null && info.getDeviceMacAddress().toString().equalsIgnoreCase(selected.getAddress())).findFirst().orElse(null);
            if (existing != null) { observe(existing.getId(), selected.getAddress()); return; }
        }
        AssociationRequest request = new AssociationRequest.Builder().addDeviceFilter(
            new BluetoothDeviceFilter.Builder().setAddress(selected.getAddress()).build()).setSingleDevice(true).build();
        CompanionDeviceManager.Callback callback = new CompanionDeviceManager.Callback() {
            @Override public void onAssociationPending(IntentSender sender) { launchConsent(sender); }
            @Override public void onDeviceFound(IntentSender sender) { launchConsent(sender); }
            @Override public void onAssociationCreated(AssociationInfo info) { if (Build.VERSION.SDK_INT >= 33) observe(info.getId(), selected.getAddress()); }
            @Override public void onFailure(CharSequence error) { PlayerService.status(MainActivity.this, "Device association was not completed"); }
        };
        if (Build.VERSION.SDK_INT >= 33) manager.associate(request, getMainExecutor(), callback);
        else manager.associate(request, callback, null);
    }

    private void launchConsent(IntentSender sender) {
        try { startIntentSenderForResult(sender, 2, null, 0, 0, 0); }
        catch (IntentSender.SendIntentException error) { PlayerService.status(this, "Unable to open Android device association"); }
    }

    private void observe(int id, String address) {
        try {
            saveName();
            CompanionDeviceManager manager = getSystemService(CompanionDeviceManager.class);
            // Save before observation: an already-connected device can report presence immediately.
            preferences.edit().putInt("association", id).putString("address", address).putBoolean("automatic", true).apply();
            if (Build.VERSION.SDK_INT >= 36) manager.startObservingDevicePresence(new ObservingDevicePresenceRequest.Builder().setAssociationId(id).build());
            else manager.startObservingDevicePresence(address);
            PlayerService.status(this, "Automatic phone player startup enabled");
            PlayerService.start(this);
        } catch (Exception error) {
            preferences.edit().putBoolean("automatic", false).apply();
            PlayerService.status(this, "Android could not enable device presence monitoring");
        }
    }

    private void disableAutomatic() {
        preferences.edit().putBoolean("automatic", false).apply();
        try {
            CompanionDeviceManager manager = getSystemService(CompanionDeviceManager.class);
            int id = preferences.getInt("association", -1);
            if (Build.VERSION.SDK_INT >= 36 && id >= 0) manager.stopObservingDevicePresence(new ObservingDevicePresenceRequest.Builder().setAssociationId(id).build());
            else if (!preferences.getString("address", "").isEmpty()) manager.stopObservingDevicePresence(preferences.getString("address", ""));
        } catch (Exception ignored) { }
        stopService(new Intent(this, PlayerService.class));
        PlayerService.status(this, "Automatic phone player startup disabled");
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) { super.onRequestPermissionsResult(code, permissions, grants); loadDevices(); }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == 2 && result == RESULT_OK && Build.VERSION.SDK_INT < 33 && data != null) {
            BluetoothDevice device = data.getParcelableExtra(CompanionDeviceManager.EXTRA_DEVICE);
            if (device != null) observe(-1, device.getAddress());
        }
    }
    @Override public void onResume() { super.onResume(); preferences.registerOnSharedPreferenceChangeListener(changed); refreshStatus(); }
    @Override public void onPause() { preferences.unregisterOnSharedPreferenceChangeListener(changed); super.onPause(); }
}
