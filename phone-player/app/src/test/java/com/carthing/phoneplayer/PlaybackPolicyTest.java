package com.carthing.phoneplayer;

import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackPolicyTest {
    @Test public void playingAndBufferingKeepTheCpuAwake() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(true, false, false, 0);
        assertTrue(policy.needsWakeLock(1_000_000));
        assertEquals(Long.MAX_VALUE, policy.nextCheckAt(0));
        policy.playback(false, true, false, 1_000_000);
        assertTrue(policy.needsWakeLock(1_000_001));
        policy.playback(false, false, false, 1_000_002);
        assertFalse(policy.needsWakeLock(1_000_002));
    }

    @Test public void idleRecoveryHasABoundedWakeWindow() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(false, false, true, 100);
        assertTrue(policy.needsWakeLock(100));
        assertEquals(60_100, policy.nextCheckAt(100));
        policy.playback(false, false, true, 59_000);
        assertFalse(policy.needsWakeLock(60_100));
        assertEquals(Long.MAX_VALUE, policy.nextCheckAt(60_100));
    }

    @Test public void bufferedPlaybackSurvivesTheRecoveryWakeDeadline() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(true, false, true, 0);
        assertTrue(policy.needsWakeLock(60_001));
        policy.playback(false, false, true, 60_001);
        assertFalse(policy.needsWakeLock(60_001));
    }

    @Test public void aNewOutageGetsANewWindowAfterAConnection() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(false, false, true, 0);
        policy.playback(false, false, false, 61_000);
        policy.playback(false, false, true, 62_000);
        assertTrue(policy.needsWakeLock(62_000));
        assertEquals(122_000, policy.nextCheckAt(62_000));
    }

    @Test public void carThingDepartureDoesNotStopActiveAudio() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(true, false, false, 0);
        policy.disappeared(10);
        assertFalse(policy.isPresent());
        assertFalse(policy.shouldStop(1_000_000));
        assertTrue(policy.needsWakeLock(1_000_000));
        assertEquals(Long.MAX_VALUE, policy.nextCheckAt(1_000_000));
    }

    @Test public void departureGraceStartsWhenPlaybackBecomesIdle() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(true, false, false, 0);
        policy.disappeared(10);
        policy.playback(false, false, false, 100_000);
        assertFalse(policy.shouldStop(114_999));
        assertEquals(115_000, policy.nextCheckAt(100_000));
        assertTrue(policy.shouldStop(115_000));
    }

    @Test public void repeatedDepartureDoesNotExtendIdleGrace() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.disappeared(100);
        policy.disappeared(14_000);
        assertFalse(policy.shouldStop(15_099));
        assertTrue(policy.shouldStop(15_100));
    }

    @Test public void idleDepartureWaitsForBoundedRecoveryThenStops() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(false, false, true, 100);
        policy.disappeared(200);
        assertEquals(15_200, policy.nextCheckAt(200));
        assertFalse(policy.shouldStop(15_200));
        assertEquals(60_100, policy.nextCheckAt(15_200));
        assertTrue(policy.shouldStop(60_100));
    }

    @Test public void returningCarThingCancelsDeparture() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.disappeared(0);
        policy.appeared();
        assertTrue(policy.isPresent());
        assertFalse(policy.shouldStop(1_000_000));
        assertEquals(Long.MAX_VALUE, policy.nextCheckAt(1_000_000));
    }

    @Test public void resumedBufferingCancelsAnIdleDepartureDeadline() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.disappeared(0);
        policy.playback(false, true, false, 14_999);
        assertFalse(policy.shouldStop(15_000));
        policy.playback(false, false, false, 20_000);
        assertFalse(policy.shouldStop(34_999));
        assertTrue(policy.shouldStop(35_000));
    }

    @Test public void stalledBufferingDoesNotHoldTheCpuForever() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(false, true, false, 0);
        assertTrue(policy.needsWakeLock(59_999));
        assertEquals(60_000, policy.nextCheckAt(0));
        policy.playback(false, true, false, 59_999);
        assertFalse(policy.needsWakeLock(60_000));
        assertEquals(Long.MAX_VALUE, policy.nextCheckAt(60_000));
    }

    @Test public void connectingAndBufferingDoNotResetTheSameRecoveryWindow() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(false, true, false, 0);
        policy.playback(false, false, true, 30_000);
        policy.playback(false, true, true, 59_999);
        assertFalse(policy.needsWakeLock(60_000));
    }

    @Test public void abandonedBufferingStopsAfterItsBoundedRecoveryWindow() {
        PlaybackPolicy policy = new PlaybackPolicy();
        policy.playback(false, true, false, 100);
        policy.disappeared(200);
        assertFalse(policy.shouldStop(60_099));
        assertTrue(policy.shouldStop(60_100));
    }
}
