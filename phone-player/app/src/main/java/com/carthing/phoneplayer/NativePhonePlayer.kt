package com.carthing.phoneplayer

import android.content.Context
import android.util.Base64
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.music_assistant.sendspin.SendspinPlayer
import io.music_assistant.sendspin.android.*
import io.music_assistant.sendspin.api.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.function.Consumer

internal class NativePhonePlayer(private val context: Context, private val status: Consumer<PhonePlayerUpdate>) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val config = MutableStateFlow<LocalPlayerConfig?>(null)
    private val secrets = PlayerSecrets(context)
    private val api = HaCloudApi(secrets)
    private val http = HttpClient(OkHttp)
    private val audioDispatcher = sendspinAudioDispatcher()
    private var player: io.music_assistant.sendspin.api.SendspinPlayer? = null
    @Volatile private var playerId: String? = null

    fun start() {
        scope.launch {
            try {
                secrets.haSession()
                secrets.verifyIdentityStorage()
                val keys = object : SendspinKeyStore {
                    override fun read(key: String): ByteArray? = secrets.get("sendspin.$key")?.let { Base64.decode(it, Base64.NO_WRAP) }
                    override fun write(key: String, value: ByteArray) { secrets.put("sendspin.$key", Base64.encodeToString(value, Base64.NO_WRAP)) }
                    override fun delete(key: String) { secrets.remove("sendspin.$key") }
                }
                val instance = SendspinPlayer(config, SendspinDeps(
                    sink = AudioTrackSink(context, ElapsedRealtimeClock),
                    decoders = AndroidDecoderFactory(), keyStore = keys, httpClient = http,
                    online = connectivityOnline(context, scope),
                    approvePairing = { token -> api.command("sendspin/pair_web_player", JSONObject().put("pairing_token", token)); Unit },
                    audioDispatcher = audioDispatcher,
                    // MA identifies authenticated app players using this generic product category.
                    deviceInfo = DeviceInfo("Mobile Application", "MusicAssistant_Bridgething", BuildConfig.VERSION_NAME),
                    clock = ElapsedRealtimeClock,
                ), scope)
                player = instance
                scope.launch {
                    instance.state.collect { state ->
                        if (state == PlayerState.Disabled) return@collect
                        if (state is PlayerState.Connected) {
                            playerId = state.playerId
                            val prefs = context.getSharedPreferences("player", Context.MODE_PRIVATE)
                            if (prefs.getString("native_player_id", null) != state.playerId) prefs.edit().putString("native_player_id", state.playerId).apply()
                        }
                        publish(phonePlayerUpdate(state))
                    }
                }
                scope.launch {
                    instance.events.collect { event ->
                        when (event) {
                            is PlayerEvent.PlaybackStopped -> if (event.cause == StopCause.FocusLost) {
                                instance.hold(true)
                                command("pause")
                            }
                            PlayerEvent.FocusRegained -> instance.hold(false)
                            is PlayerEvent.StreamStartedWhileHeld -> command("pause")
                            else -> Unit
                        }
                    }
                }
                // The SDK's app-managed transport port also accepts native WSS frames.
                // Authentication and ingress renewal happen on every attempt, on the phone.
                config.value = LocalPlayerConfig(
                    endpoint = Endpoint.WebRtc(WireVersion.SPEC_1_0) { api.openTransport() },
                    deviceName = context.getSharedPreferences("player", Context.MODE_PRIVATE).getString("player_name", "CarThing Phone") ?: "CarThing Phone",
                    codecPreference = listOf(AudioCodec.OPUS, AudioCodec.FLAC), bufferSeconds = 3, userDelayMs = 0,
                )
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { publish(PhonePlayerUpdate("Phone player setup failed; open CarThing Phone Player and sign in")) }
        }
    }

    private var lastStatus: PhonePlayerUpdate? = null
    private fun publish(value: PhonePlayerUpdate) {
        if (lastStatus == value) return
        lastStatus = value
        status.accept(value)
    }

    fun command(action: String) {
        if (action !in setOf("pause", "play", "stop")) return
        val id = playerId ?: return
        scope.launch { runCatching { api.command("players/cmd/$action", JSONObject().put("player_id", id)) } }
    }

    @JvmOverloads fun stop(after: Runnable? = null) {
        config.value = null
        player?.hold(true)
        scope.cancel()
        api.close()
        http.close()
        CoroutineScope(Dispatchers.IO).launch {
            scope.coroutineContext[Job]?.join()
            audioDispatcher.close()
            after?.run()
        }
        player = null
    }
}
