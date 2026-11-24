package com.carthing.phoneplayer;

import android.companion.DevicePresenceEvent;
import org.junit.Test;
import static org.junit.Assert.*;

public class PresenceTrackerTest {
    @Test public void supportsBleOnlyArrivalAndDeparture() {
        PresenceTracker tracker = new PresenceTracker();
        assertEquals(Boolean.TRUE, tracker.update(DevicePresenceEvent.EVENT_BLE_APPEARED));
        assertEquals(Boolean.FALSE, tracker.update(DevicePresenceEvent.EVENT_BLE_DISAPPEARED));
    }
    @Test public void doesNotStopWhileEitherTransportReportsPresence() {
        PresenceTracker tracker = new PresenceTracker();
        tracker.update(DevicePresenceEvent.EVENT_BT_CONNECTED);
        tracker.update(DevicePresenceEvent.EVENT_BLE_APPEARED);
        assertEquals(Boolean.TRUE, tracker.update(DevicePresenceEvent.EVENT_BLE_DISAPPEARED));
        assertEquals(Boolean.FALSE, tracker.update(DevicePresenceEvent.EVENT_BT_DISCONNECTED));
        tracker.update(DevicePresenceEvent.EVENT_BLE_APPEARED);
        assertEquals(Boolean.TRUE, tracker.update(DevicePresenceEvent.EVENT_BT_DISCONNECTED));
    }
    @Test public void ignoresUnrelatedEvents() { assertNull(new PresenceTracker().update(-100)); }
}
