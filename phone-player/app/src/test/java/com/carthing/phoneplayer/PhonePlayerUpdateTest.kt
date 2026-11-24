package com.carthing.phoneplayer

import io.music_assistant.sendspin.api.*
import org.junit.Assert.*
import org.junit.Test

class PhonePlayerUpdateTest {
    @Test fun bufferedPlaybackIsStillPlayingWhileReconnecting() {
        val update = phonePlayerUpdate(PlayerState.Reconnecting(1, 1000, AudioStatus(AudioPhase.Playing, 500, false)))
        assertTrue(update.playing)
        assertTrue(update.recovering)
        assertFalse(update.ready)
        assertEquals("Reconnecting phone audio", update.message)
    }

    @Test fun waitingForNetworkPreservesBufferedAudioState() {
        val update = phonePlayerUpdate(PlayerState.Reconnecting(1, null, AudioStatus(AudioPhase.Buffering, 300, false)))
        assertTrue(update.buffering)
        assertTrue(update.recovering)
        assertEquals("Waiting for phone network", update.message)
    }

    @Test fun initialConnectRequestsBoundedRecoveryProtection() {
        val update = phonePlayerUpdate(PlayerState.Connecting(1))
        assertTrue(update.recovering)
        assertFalse(update.playing)
        assertFalse(update.ready)
    }

    @Test fun connectedBufferingIsReadyButNotPausedPlayback() {
        val update = phonePlayerUpdate(PlayerState.Connected("fixture", "test", ClockQuality.Good, AudioStatus(AudioPhase.Buffering, 50, false)))
        assertTrue(update.ready)
        assertTrue(update.buffering)
        assertFalse(update.playing)
        assertFalse(update.recovering)
    }

    @Test fun connectedIdleDoesNotKeepTheCpuAwake() {
        val update = phonePlayerUpdate(PlayerState.Connected("fixture", "test", ClockQuality.Good, AudioStatus.IDLE))
        assertTrue(update.ready)
        assertFalse(update.playing)
        assertFalse(update.buffering)
        assertFalse(update.recovering)
    }

    @Test fun starvationIsReportedWithoutLosingThePlayingIntent() {
        val update = phonePlayerUpdate(PlayerState.Connected("fixture", "test", ClockQuality.Degraded, AudioStatus(AudioPhase.Playing, 0, true)))
        assertTrue(update.playing)
        assertTrue(update.starved)
    }

    @Test fun fatalFailureReleasesRecoveryProtection() {
        val update = phonePlayerUpdate(PlayerState.Failed(FailureCause.Unauthorized))
        assertFalse(update.recovering)
        assertFalse(update.playing)
        assertFalse(update.buffering)
        assertFalse(update.ready)
    }
}
