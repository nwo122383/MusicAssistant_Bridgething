package com.carthing.phoneplayer;

import android.companion.AssociationInfo;
import android.companion.CompanionDeviceService;
import android.companion.DevicePresenceEvent;
import android.content.Intent;

public final class CarPresenceService extends CompanionDeviceService {
    private boolean enabled() { return getSharedPreferences("player", MODE_PRIVATE).getBoolean("automatic", false); }

    private void appeared() { if (enabled()) PlayerService.start(this); }
    private void disappeared() {
        if (getSharedPreferences("player", MODE_PRIVATE).getBoolean("running", false)) {
            try { startService(new Intent(this, PlayerService.class).setAction(PlayerService.GONE)); }
            catch (RuntimeException error) { stopService(new Intent(this, PlayerService.class)); }
        }
    }

    @Override public void onDevicePresenceEvent(DevicePresenceEvent event) {
        if (event.getAssociationId() != getSharedPreferences("player", MODE_PRIVATE).getInt("association", -1)) return;
        if (event.getEvent() == DevicePresenceEvent.EVENT_BT_CONNECTED) appeared();
        else if (event.getEvent() == DevicePresenceEvent.EVENT_BT_DISCONNECTED) disappeared();
    }
    @Override public void onDeviceAppeared(AssociationInfo info) { if (info.getId() == getSharedPreferences("player", MODE_PRIVATE).getInt("association", -1)) appeared(); }
    @Override public void onDeviceDisappeared(AssociationInfo info) { if (info.getId() == getSharedPreferences("player", MODE_PRIVATE).getInt("association", -1)) disappeared(); }
    @Override public void onDeviceAppeared(String address) { if (address.equals(getSharedPreferences("player", MODE_PRIVATE).getString("address", ""))) appeared(); }
    @Override public void onDeviceDisappeared(String address) { if (address.equals(getSharedPreferences("player", MODE_PRIVATE).getString("address", ""))) disappeared(); }
}
