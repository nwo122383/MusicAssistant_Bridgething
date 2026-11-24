package com.carthing.phoneplayer;

import android.companion.AssociationInfo;
import android.companion.CompanionDeviceService;
import android.companion.DevicePresenceEvent;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

public final class CarPresenceService extends CompanionDeviceService {
    private final PresenceTracker presence = new PresenceTracker();
    private boolean enabled() { return getSharedPreferences("player", MODE_PRIVATE).getBoolean("automatic", false); }

    private void appeared() {
        if (enabled()) {
            Log.i("CarThingPhonePlayer", "Associated Car Thing present; starting phone receiver");
            PlayerService.start(this);
        }
    }
    private void disappeared() {
        Log.i("CarThingPhonePlayer", "Associated Car Thing absent; applying disconnect grace period");
        if (getSharedPreferences("player", MODE_PRIVATE).getBoolean("running", false)) {
            try { startService(new Intent(this, PlayerService.class).setAction(PlayerService.GONE)); }
            catch (RuntimeException error) { Log.w("CarThingPhonePlayer", "Could not deliver departure notice; preserving the existing audio service"); }
        }
    }

    @Override public void onDevicePresenceEvent(DevicePresenceEvent event) {
        if (Build.VERSION.SDK_INT < 36) return;
        if (event.getAssociationId() != getSharedPreferences("player", MODE_PRIVATE).getInt("association", -1)) return;
        Boolean nearby = presence.update(event.getEvent());
        if (Boolean.TRUE.equals(nearby)) appeared();
        else if (Boolean.FALSE.equals(nearby)) disappeared();
    }
    @Override public void onDeviceAppeared(AssociationInfo info) { if (Build.VERSION.SDK_INT >= 33 && info.getId() == getSharedPreferences("player", MODE_PRIVATE).getInt("association", -1)) appeared(); }
    @Override public void onDeviceDisappeared(AssociationInfo info) { if (Build.VERSION.SDK_INT >= 33 && info.getId() == getSharedPreferences("player", MODE_PRIVATE).getInt("association", -1)) disappeared(); }
    @Override public void onDeviceAppeared(String address) { if (address.equals(getSharedPreferences("player", MODE_PRIVATE).getString("address", ""))) appeared(); }
    @Override public void onDeviceDisappeared(String address) { if (address.equals(getSharedPreferences("player", MODE_PRIVATE).getString("address", ""))) disappeared(); }
}
