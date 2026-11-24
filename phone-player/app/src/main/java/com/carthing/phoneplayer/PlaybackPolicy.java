package com.carthing.phoneplayer;

final class PlaybackPolicy {
    // Radio presence controls idle shutdown, not the lifetime of active phone audio.
    static final long RECOVERY_WAKE_MS = 60_000;
    static final long DEPARTURE_GRACE_MS = 15_000;
    private boolean present = true, playing, buffering, waiting;
    private long recoveryUntil = -1, idleAbsentSince = -1;

    void playback(boolean playing, boolean buffering, boolean reconnecting, long now) {
        this.playing = playing;
        this.buffering = buffering;
        boolean needsRecovery = reconnecting || buffering;
        if (needsRecovery && !waiting) recoveryUntil = now + RECOVERY_WAKE_MS;
        else if (!needsRecovery) recoveryUntil = -1;
        waiting = needsRecovery;
        updateIdleAbsence(now);
    }

    void appeared() { present = true; idleAbsentSince = -1; }
    void disappeared(long now) { present = false; updateIdleAbsence(now); }
    boolean isPresent() { return present; }
    boolean needsWakeLock(long now) { return playing || recoveryUntil > now; }
    boolean shouldStop(long now) {
        return !present && !playing && recoveryUntil <= now &&
            (buffering || idleAbsentSince >= 0 && now - idleAbsentSince >= DEPARTURE_GRACE_MS);
    }

    long nextCheckAt(long now) {
        if (playing) return Long.MAX_VALUE;
        long next = recoveryUntil > now ? recoveryUntil : Long.MAX_VALUE;
        if (!present && idleAbsentSince >= 0 && idleAbsentSince + DEPARTURE_GRACE_MS > now)
            next = Math.min(next, idleAbsentSince + DEPARTURE_GRACE_MS);
        return next;
    }

    private void updateIdleAbsence(long now) {
        if (present || playing || buffering) idleAbsentSince = -1;
        else if (idleAbsentSince < 0) idleAbsentSince = now;
    }
}
