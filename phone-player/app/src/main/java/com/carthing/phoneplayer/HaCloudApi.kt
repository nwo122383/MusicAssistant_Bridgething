package com.carthing.phoneplayer

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import io.music_assistant.sendspin.api.Frame
import io.music_assistant.sendspin.api.SendspinTransport

internal data class HaIngress(val base: String, val cookie: String)

internal class HaCloudApi(private val secrets: PlayerSecrets) {
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()
    @Volatile private var activeIngress: HaIngress? = null

    suspend fun prepare(): HaIngress = withContext(Dispatchers.IO) {
        val session = renewedSession()
        val origin = ConnectionRules.origin(session.getString("origin"))
        HaRpc(http, origin, session.getString("accessToken")).use { ha ->
            ha.ready()
            val panels = ha.request("get_panels") as? JSONObject ?: error("Home Assistant panels are unavailable")
            val candidates = panels.keys().asSequence().mapNotNull { panels.optJSONObject(it) }
                .filter { panel ->
                    val addon = panel.optJSONObject("config")?.optString("addon").orEmpty()
                    addon.isNotEmpty() && Regex("music.?assistant", RegexOption.IGNORE_CASE)
                        .containsMatchIn(panel.optString("title") + " " + addon)
                }.toList()
            check(candidates.size == 1) { "A single Music Assistant add-on with Home Assistant ingress is required" }
            val slug = candidates.single().getJSONObject("config").getString("addon")
            check(Regex("[A-Za-z0-9_-]+").matches(slug)) { "Music Assistant add-on identifier is invalid" }
            val info = ha.request("supervisor/api", JSONObject().put("endpoint", "/addons/$slug/info").put("method", "get")) as JSONObject
            val ingressSession = ha.request("supervisor/api", JSONObject().put("endpoint", "/ingress/session").put("method", "post")) as JSONObject
            val cookie = ingressSession.getString("session")
            check(cookie.isNotEmpty() && cookie.all { it.isLetterOrDigit() || it in "_-" }) { "Home Assistant ingress session is invalid" }
            val route = HaIngress(ConnectionRules.ingress(origin, info.getString("ingress_url")), "ingress_session=$cookie")
            val server = jsonRequest(route, "info") as? JSONObject ?: error("Music Assistant server information is invalid")
            check(server.optInt("schema_version", 0) >= 45) { "This Music Assistant server needs encrypted Sendspin support (schema 45 or newer)" }
            activeIngress = route
            route
        }
    }

    suspend fun command(command: String, args: JSONObject = JSONObject()): Any? = withContext(Dispatchers.IO) {
        val route = activeIngress ?: error("Phone audio is not connected")
        val result = jsonRequest(route, "api", JSONObject().put("message_id", "phone-player")
            .put("command", command).put("args", args))
        check(result !is JSONObject || (!result.has("error_code") && !result.has("error"))) { "Music Assistant rejected the phone-player command" }
        if (result == JSONObject.NULL) null else result
    }

    suspend fun openTransport(): SendspinTransport {
        val route = prepare()
        val url = "wss://" + route.base.removePrefix("https://") + "sendspin"
        return NativeSendspinSocket.open(http, Request.Builder().url(url).header("Cookie", route.cookie).build())
    }

    fun close() {
        activeIngress = null
        http.dispatcher.cancelAll()
        http.connectionPool.evictAll()
        http.dispatcher.executorService.shutdown()
    }

    private fun renewedSession(): JSONObject {
        val session = secrets.haSession()
        if (session.getLong("expiresAt") > System.currentTimeMillis() + 60_000) return session
        val origin = ConnectionRules.origin(session.getString("origin"))
        val body = FormBody.Builder().add("grant_type", "refresh_token")
            .add("refresh_token", session.getString("refreshToken"))
            .add("client_id", PlayerSecrets.HA_CLIENT_ID).build()
        http.newCall(Request.Builder().url("$origin/auth/token").post(body).build()).execute().use { response ->
            check(response.isSuccessful) { if (response.code in listOf(400, 401, 403)) "Sign in to Home Assistant again" else "Home Assistant login renewal failed (${response.code})" }
            val result = JSONObject(response.body?.string() ?: error("Home Assistant login renewal is empty"))
            val ttl = result.getLong("expires_in")
            val token = result.getString("access_token")
            check(ttl in 1..86_400 && token.isNotEmpty()) { "Home Assistant returned invalid login credentials" }
            check(!result.has("refresh_token") || result.getString("refresh_token") == session.getString("refreshToken")) { "Home Assistant login changed; sign in again" }
            session.put("accessToken", token).put("expiresAt", System.currentTimeMillis() + ttl * 1000)
            secrets.saveHaSession("ha-oauth-v1:$session")
            return session
        }
    }

    private fun jsonRequest(route: HaIngress, path: String, body: JSONObject? = null): Any {
        check(path in listOf("api", "info"))
        val request = Request.Builder().url(route.base + path).header("Cookie", route.cookie)
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
        http.newCall(request.build()).execute().use { response ->
            check(response.isSuccessful) { "Music Assistant ingress request failed (${response.code})" }
            val data = response.body?.string() ?: error("Music Assistant returned an empty response")
            check(data.length <= 1_048_576) { "Music Assistant response is too large" }
            return JSONTokener(data).nextValue()
        }
    }
}

private class HaRpc(client: OkHttpClient, origin: String, private val token: String) : AutoCloseable {
    private val connected = CompletableDeferred<Unit>()
    private val sequence = AtomicInteger()
    private val pending = java.util.concurrent.ConcurrentHashMap<Int, CompletableDeferred<Any?>>()
    private val socket = client.newWebSocket(Request.Builder().url("wss://" + origin.removePrefix("https://") + "/api/websocket").build(), object : WebSocketListener() {
        override fun onMessage(ws: WebSocket, text: String) {
            try {
                val data = JSONObject(text)
                when (data.optString("type")) {
                    "auth_required" -> ws.send(JSONObject().put("type", "auth").put("access_token", token).toString())
                    "auth_ok" -> connected.complete(Unit)
                    "auth_invalid" -> fail(IllegalStateException("Home Assistant rejected the saved login; sign in again"))
                    "result" -> pending.remove(data.optInt("id"))?.let { request ->
                        if (data.optBoolean("success")) request.complete(data.opt("result"))
                        else request.completeExceptionally(IllegalStateException("Home Assistant rejected a phone-player setup request"))
                    }
                }
            } catch (_: Exception) { fail(IOException("Home Assistant returned an invalid response")) }
        }
        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { fail(IOException("Home Assistant connection failed")) }
        override fun onClosed(ws: WebSocket, code: Int, reason: String) { fail(IOException("Home Assistant connection closed")) }
        override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, null); fail(IOException("Home Assistant connection closed")) }
    })

    suspend fun ready() { withTimeout(20_000) { connected.await() } }
    suspend fun request(type: String, args: JSONObject = JSONObject()): Any? {
        val id = sequence.incrementAndGet()
        val result = CompletableDeferred<Any?>()
        pending[id] = result
        try {
            check(socket.send(JSONObject(args.toString()).put("id", id).put("type", type).toString())) { "Home Assistant connection closed" }
            return withTimeout(20_000) { result.await() }
        } finally { pending.remove(id) }
    }
    private fun fail(error: Throwable) {
        connected.completeExceptionally(error)
        pending.values.forEach { it.completeExceptionally(error) }
        pending.clear()
    }
    override fun close() { socket.close(1000, null); fail(IOException("Home Assistant setup ended")) }
}

private class NativeSendspinSocket private constructor(client: OkHttpClient, request: Request) : SendspinTransport {
    private val frames = Channel<Frame>(64)
    private val opened = CompletableDeferred<Unit>()
    override val inbound get() = frames
    private val socket = client.newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) { opened.complete(Unit) }
        override fun onMessage(ws: WebSocket, text: String) {
            if (text.length > 65_536 || !frames.trySend(Frame.Text(text)).isSuccess) overflow(ws)
        }
        override fun onMessage(ws: WebSocket, bytes: ByteString) {
            if (bytes.size > 2_097_152 || !frames.trySend(Frame.Binary(bytes.toByteArray())).isSuccess) overflow(ws)
        }
        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { failed(IOException("Phone audio connection failed")) }
        override fun onClosed(ws: WebSocket, code: Int, reason: String) { failed(IOException("Phone audio disconnected")) }
        override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, null); failed(IOException("Phone audio disconnected")) }
    })
    private fun overflow(ws: WebSocket) { failed(IOException("Phone audio buffer exceeded its limit")); ws.cancel() }
    private fun failed(error: Throwable) { opened.completeExceptionally(error); frames.close(error) }
    override suspend fun send(frame: Frame) {
        val sent = when (frame) {
            is Frame.Text -> socket.send(frame.text)
            is Frame.Binary -> socket.send(ByteString.of(*frame.bytes))
        }
        check(sent) { "Phone audio connection is closed" }
    }
    override suspend fun close() { frames.close(); socket.close(1000, null) }
    companion object {
        suspend fun open(client: OkHttpClient, request: Request): SendspinTransport {
            val transport = NativeSendspinSocket(client, request)
            try { withTimeout(20_000) { transport.opened.await() }; return transport }
            catch (error: Throwable) { transport.socket.cancel(); throw error }
        }
    }
}
