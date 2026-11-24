package com.carthing.phoneplayer

import io.music_assistant.sendspin.api.AudioPhase
import io.music_assistant.sendspin.api.PlayerState

internal data class PhonePlayerUpdate(
    val message: String,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val recovering: Boolean = false,
    val ready: Boolean = false,
    val starved: Boolean = false,
)

internal fun phonePlayerUpdate(state: PlayerState): PhonePlayerUpdate {
    val audio = when (state) {
        is PlayerState.Connected -> state.audio
        is PlayerState.Reconnecting -> state.audio
        else -> null
    }
    val playing = audio?.phase == AudioPhase.Playing
    val buffering = audio?.phase == AudioPhase.Buffering
    val message = when (state) {
        is PlayerState.Connected -> when {
            playing -> "Phone audio playing"
            buffering -> "Buffering phone audio"
            else -> "Phone player ready"
        }
        is PlayerState.Connecting -> "Connecting phone audio"
        is PlayerState.Reconnecting -> if (state.nextRetryAtMs == null) "Waiting for phone network" else "Reconnecting phone audio"
        is PlayerState.Failed -> "Phone player stopped: ${state.cause}; check sign-in"
        PlayerState.Disabled -> "Phone player stopped"
    }
    return PhonePlayerUpdate(message, playing, buffering,
        recovering = state is PlayerState.Connecting || state is PlayerState.Reconnecting,
        ready = state is PlayerState.Connected, starved = audio?.starved == true)
}
