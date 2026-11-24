package com.carthing.phoneplayer;

import android.companion.DevicePresenceEvent;

final class PresenceTracker {
    private boolean bluetooth, ble;

    Boolean update(int event) {
        switch (event) {
            case DevicePresenceEvent.EVENT_BT_CONNECTED: bluetooth = true; break;
            case DevicePresenceEvent.EVENT_BT_DISCONNECTED: bluetooth = false; break;
            case DevicePresenceEvent.EVENT_BLE_APPEARED: ble = true; break;
            case DevicePresenceEvent.EVENT_BLE_DISAPPEARED: ble = false; break;
            default: return null;
        }
        return bluetooth || ble;
    }
}
