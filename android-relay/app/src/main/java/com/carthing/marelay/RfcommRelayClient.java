package com.carthing.marelay;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public final class RfcommRelayClient implements AutoCloseable {
    public interface Listener {
        void onStatus(String status);
        void onMessage(String message);
        void onError(Throwable error);
    }

    private final Context context;
    private final BluetoothAdapter adapter;
    private final Listener listener;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final AtomicLong sequence = new AtomicLong(1);
    private final Map<Long, Long> pendingStartedAt = new ConcurrentHashMap<>();
    private final Map<String, Long> pendingImageRequests = new ConcurrentHashMap<>();
    private volatile BluetoothSocket socket;

    private final OkHttpClient okHttpClient = new OkHttpClient();
    private final Object writeLock = new Object();
    private volatile WebSocket massWebSocket;
    private String massUrl;
    private String haToken;
    private volatile String cookieHeader;
    private final AtomicBoolean failureReported = new AtomicBoolean(false);
    private volatile boolean closing = false;

    // WebRTC Fields
    private volatile PeerConnectionFactory peerConnectionFactory;
    private volatile PeerConnection peerConnection;
    private volatile DataChannel webrtcDataChannel;
    private volatile WebSocket signalingWebSocket;
    private volatile String sessionId;

    public RfcommRelayClient(Context context, BluetoothAdapter adapter, Listener listener) {
        this.context = context;
        this.adapter = adapter;
        this.listener = listener;
        try {
            System.loadLibrary("jingle_peerconnection_so");
            PeerConnectionFactory.InitializationOptions initializationOptions =
                    PeerConnectionFactory.InitializationOptions.builder(context)
                            .createInitializationOptions();
            PeerConnectionFactory.initialize(initializationOptions);
            peerConnectionFactory = PeerConnectionFactory.builder().createPeerConnectionFactory();
            Log.d("MARelay", "Constructor factory initialized in client " + this + ": " + peerConnectionFactory);
        } catch (Throwable e) {
            Log.e("MARelay", "WebRTC Factory Init failed", e);
            listener.onMessage("WebRTC Factory Init failed: " + e.getClass().getSimpleName() + " - " + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    public void connect(BluetoothDevice device, String massUrl, String haToken) {
        closing = false;
        failureReported.set(false);
        if (massUrl != null && massUrl.contains("_music_assistant") && !massUrl.contains("api/hassio_ingress")) {
            int slugIndex = massUrl.lastIndexOf('/');
            if (slugIndex != -1) {
                String hostPart = massUrl.substring(0, slugIndex);
                String slugPart = massUrl.substring(slugIndex + 1);
                massUrl = hostPart + "/api/hassio_ingress/" + slugPart + "/";
            }
        }
        this.massUrl = massUrl;
        this.haToken = haToken;
        closeSocket();
        closeWebSocket();
        executor.execute(() -> {
            try {
                listener.onStatus("Connecting to " + device.getName() + "…");
                adapter.cancelDiscovery();
                BluetoothSocket next = device.createRfcommSocketToServiceRecord(RelayProtocol.SERVICE_UUID);
                next.connect();
                socket = next;
                listener.onStatus("Bluetooth relay connected");

                // Check if HA Token is provided, if so fetch the Ingress session cookie
                cookieHeader = null;
                boolean isRemoteId = (this.massUrl != null && (this.massUrl.startsWith("MA-") || !this.massUrl.contains("://")));
                if (isRemoteId) {
                    connectMusicAssistantWebRtc();
                } else {
                    if (this.haToken != null && !this.haToken.isEmpty() && this.massUrl.contains("hassio_ingress")) {
                        listener.onStatus("Authenticating HA Remote Access…");
                        String sessionToken = fetchIngressSession(this.massUrl, this.haToken);
                        cookieHeader = "ingress_session=" + sessionToken;
                        listener.onMessage("Established Home Assistant Ingress session");
                    }
                    connectMusicAssistantWebSocket();
                }

                send(RelayProtocol.HELLO,
                        "{\"client\":\"android\",\"version\":1}".getBytes(StandardCharsets.UTF_8));
                readLoop(next);
            } catch (Throwable error) {
                closeSocket();
                closeWebSocket();
                reportTransportFailure(error);
            }
        });
    }

    private void reportTransportFailure(Throwable error) {
        if (closing) {
            return;
        }
        if (failureReported.compareAndSet(false, true)) {
            listener.onError(error);
        }
    }

    private String fetchIngressSession(String massUrl, String haToken) throws IOException {
        try {
            java.net.URL url = new java.net.URL(massUrl);
            String haBaseUrl = url.getProtocol() + "://" + url.getHost();
            if (url.getPort() != -1) {
                haBaseUrl += ":" + url.getPort();
            }

            // Step 1: Verify token validity generally by calling HA /api/config
            Request testReq = new Request.Builder()
                    .url(haBaseUrl + "/api/config")
                    .get()
                    .addHeader("Authorization", "Bearer " + haToken)
                    .build();
            try (Response testResp = okHttpClient.newCall(testReq).execute()) {
                if (testResp.code() == 401) {
                    throw new IOException("HA token is invalid (HTTP 401 on /api/config). Check your copied key.");
                }
            }

            // Step 2: Request Ingress Session
            String sessionUrl = haBaseUrl + "/api/hassio/ingress/session";
            RequestBody body = RequestBody.create("", MediaType.parse("application/json"));
            Request req = new Request.Builder()
                    .url(sessionUrl)
                    .post(body)
                    .addHeader("Authorization", "Bearer " + haToken)
                    .build();

            try (Response resp = okHttpClient.newCall(req).execute()) {
                if (!resp.isSuccessful()) {
                    throw new IOException("HTTP " + resp.code() + ": " + resp.message());
                }
                String jsonStr = resp.body().string();
                int dataIndex = jsonStr.indexOf("\"session\"");
                if (dataIndex == -1) {
                    throw new IOException("Invalid session response: " + jsonStr);
                }
                int colonIndex = jsonStr.indexOf(":", dataIndex);
                int quoteStart = jsonStr.indexOf("\"", colonIndex);
                int quoteEnd = jsonStr.indexOf("\"", quoteStart + 1);
                if (quoteStart == -1 || quoteEnd == -1) {
                    throw new IOException("Failed parsing session token from: " + jsonStr);
                }
                return jsonStr.substring(quoteStart + 1, quoteEnd);
            }
        } catch (Exception e) {
            throw new IOException("Home Assistant Ingress auth failed: " + e.getMessage(), e);
        }
    }

    private void connectMusicAssistantWebSocket() {
        String wsUrl = massUrl.replace("http://", "ws://").replace("https://", "wss://");
        if (!wsUrl.endsWith("/ws")) {
            wsUrl = wsUrl.replaceAll("/$", "") + "/ws";
        }
        
        Request.Builder builder = new Request.Builder().url(wsUrl);
        if (cookieHeader != null) {
            builder.addHeader("Cookie", cookieHeader);
        } else if (haToken != null && !haToken.isEmpty()) {
            builder.addHeader("Authorization", "Bearer " + haToken);
        }
        Request request = builder.build();
        massWebSocket = okHttpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                listener.onMessage("Connected to Music Assistant WebSocket");
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                send(RelayProtocol.WS_TEXT, text.getBytes(StandardCharsets.UTF_8));
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                listener.onMessage("Music Assistant WebSocket closing: " + reason);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                listener.onMessage("Music Assistant WebSocket closed: " + reason);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                listener.onMessage("Music Assistant WebSocket failure: " + t.getMessage());
                reportTransportFailure(new IOException("Music Assistant WebSocket failure: " + t.getMessage(), t));
            }
        });
    }

    private void closeWebSocket() {
        WebSocket ws = massWebSocket;
        massWebSocket = null;
        if (ws != null) {
            ws.close(1000, "Relay client closed");
        }

        WebSocket sigWs = signalingWebSocket;
        signalingWebSocket = null;
        if (sigWs != null) {
            sigWs.close(1000, "Relay client closed");
        }

        DataChannel dataChannel = webrtcDataChannel;
        webrtcDataChannel = null;
        if (dataChannel != null) {
            try {
                dataChannel.unregisterObserver();
                dataChannel.close();
            } catch (Exception e) {}
        }

        if (peerConnection != null) {
            try {
                peerConnection.close();
            } catch (Exception e) {}
            peerConnection = null;
        }

        sessionId = null;
    }

    public void ping() {
        sendMeasured(RelayProtocol.PING, "pixel-ping".getBytes(StandardCharsets.UTF_8));
    }

    public void benchmark(int size) {
        byte[] payload = new byte[size];
        new SecureRandom().nextBytes(payload);
        sendMeasured(RelayProtocol.BENCHMARK, payload);
    }

    private void sendMeasured(int type, byte[] payload) {
        long id = sequence.getAndIncrement();
        pendingStartedAt.put(id, System.nanoTime());
        sendFrame(new RelayFrame(type, 0, id, payload));
    }

    private void send(int type, byte[] payload) {
        sendFrame(new RelayFrame(type, 0, sequence.getAndIncrement(), payload));
    }

    private void sendFrame(RelayFrame frame) {
        executor.execute(() -> {
            BluetoothSocket current = socket;
            if (current == null || !current.isConnected()) {
                listener.onMessage("Relay is not connected");
                return;
            }
            try {
                synchronized (writeLock) {
                    RelayFrameCodec.write(current.getOutputStream(), frame);
                }
            } catch (IOException error) {
                listener.onError(error);
                closeSocket();
                closeWebSocket();
            }
        });
    }

    private void readLoop(BluetoothSocket connectedSocket) throws IOException {
        while (connectedSocket == socket && connectedSocket.isConnected()) {
            RelayFrame frame = RelayFrameCodec.read(connectedSocket.getInputStream());
            if (frame.type() == RelayProtocol.HELLO_ACK) {
                listener.onMessage("Handshake: " + new String(frame.payload(), StandardCharsets.UTF_8));
                continue;
            }
            if (frame.type() == RelayProtocol.WS_TEXT) {
                if (massWebSocket != null) {
                    String text = new String(frame.payload(), StandardCharsets.UTF_8);
                    massWebSocket.send(text);
                } else if (webrtcDataChannel != null && webrtcDataChannel.state() == DataChannel.State.OPEN) {
                    ByteBuffer buffer = ByteBuffer.wrap(frame.payload());
                    webrtcDataChannel.send(new DataChannel.Buffer(buffer, false));
                }
                continue;
            }
            if (frame.type() == RelayProtocol.IMAGE_GET) {
                final long requestId = frame.requestId();
                String path = new String(frame.payload(), StandardCharsets.UTF_8);
                String subPath = path;
                if (subPath.startsWith("/mass")) {
                    subPath = subPath.substring(5);
                }
                
                if (webrtcDataChannel != null && webrtcDataChannel.state() == DataChannel.State.OPEN) {
                    String proxyId = "img_" + sequence.getAndIncrement();
                    pendingImageRequests.put(proxyId, requestId);
                    try {
                        JSONObject req = new JSONObject();
                        req.put("type", "http-proxy-request");
                        req.put("id", proxyId);
                        req.put("method", "GET");
                        req.put("path", subPath);
                        req.put("headers", new JSONObject());
                        
                        byte[] jsonBytes = req.toString().getBytes(StandardCharsets.UTF_8);
                        webrtcDataChannel.send(new DataChannel.Buffer(ByteBuffer.wrap(jsonBytes), false));
                    } catch (Exception e) {
                        listener.onMessage("WebRTC image proxy request error: " + e.getMessage());
                        sendFrame(new RelayFrame(RelayProtocol.ERROR, 0, requestId, e.getMessage().getBytes(StandardCharsets.UTF_8)));
                    }
                    continue;
                }
                
                String imageUrl = massUrl.replaceAll("/$", "") + subPath;
                if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
                    listener.onMessage("Skipping image fetch for non-HTTP URL: " + imageUrl);
                    sendFrame(new RelayFrame(RelayProtocol.ERROR, 0, requestId, "Invalid URL scheme".getBytes(StandardCharsets.UTF_8)));
                    continue;
                }
                
                Request.Builder imgBuilder;
                try {
                    imgBuilder = new Request.Builder().url(imageUrl);
                } catch (IllegalArgumentException e) {
                    listener.onMessage("Invalid image URL: " + imageUrl);
                    sendFrame(new RelayFrame(RelayProtocol.ERROR, 0, requestId, "Invalid URL format".getBytes(StandardCharsets.UTF_8)));
                    continue;
                }
                if (cookieHeader != null) {
                    imgBuilder.addHeader("Cookie", cookieHeader);
                } else if (haToken != null && !haToken.isEmpty()) {
                    imgBuilder.addHeader("Authorization", "Bearer " + haToken);
                }
                Request imgRequest = imgBuilder.build();
                okHttpClient.newCall(imgRequest).enqueue(new Callback() {
                    @Override
                    public void onFailure(Call call, IOException e) {
                        listener.onMessage("Image fetch failed: " + e.getMessage());
                        sendFrame(new RelayFrame(RelayProtocol.ERROR, 0, requestId, e.getMessage().getBytes(StandardCharsets.UTF_8)));
                    }

                    @Override
                    public void onResponse(Call call, Response response) throws IOException {
                        if (!response.isSuccessful()) {
                            sendFrame(new RelayFrame(RelayProtocol.ERROR, 0, requestId, ("HTTP " + response.code()).getBytes(StandardCharsets.UTF_8)));
                            response.close();
                            return;
                        }
                        byte[] imageBytes = response.body().bytes();
                        sendFrame(new RelayFrame(RelayProtocol.IMAGE_DATA, 0, requestId, imageBytes));
                        response.close();
                    }
                });
                continue;
            }
            if (frame.type() == RelayProtocol.PONG || frame.type() == RelayProtocol.BENCHMARK_ACK) {
                Long started = pendingStartedAt.remove(frame.requestId());
                if (started != null) {
                    double elapsedMs = (System.nanoTime() - started) / 1_000_000.0;
                    if (frame.type() == RelayProtocol.PONG) {
                        listener.onMessage(String.format("Ping %.1f ms", elapsedMs));
                    } else {
                        double kibPerSecond = frame.payload().length / 1024.0 / (elapsedMs / 1000.0);
                        listener.onMessage(String.format(
                                "Round-trip %,d bytes in %.1f ms (%.1f KiB/s)",
                                frame.payload().length, elapsedMs, kibPerSecond));
                    }
                }
                continue;
            }
            if (frame.type() == RelayProtocol.ERROR) {
                listener.onMessage("Relay error: " + new String(frame.payload(), StandardCharsets.UTF_8));
            }
        }
    }

    private void closeSocket() {
        BluetoothSocket current = socket;
        socket = null;
        if (current != null) {
            try {
                current.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void connectMusicAssistantWebRtc() {
        listener.onStatus("Initializing WebRTC…");
        Log.d("MARelay", "Checking factory in client " + this + ": " + peerConnectionFactory);
        if (peerConnectionFactory == null) {
            listener.onError(new IOException("WebRTC factory is null in client " + this));
            return;
        }

        // Connect to signaling server
        String sigUrl = "wss://signaling.music-assistant.io/ws";
        Request request = new Request.Builder().url(sigUrl).build();
        
        signalingWebSocket = okHttpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                listener.onMessage("Connected to signaling server");
                try {
                    JSONObject reg = new JSONObject();
                    reg.put("type", "connect-request");
                    reg.put("remoteId", RfcommRelayClient.this.massUrl.replace("-", "").toLowerCase());
                    webSocket.send(reg.toString());
                    listener.onMessage("Sent connection request for Remote ID: " + RfcommRelayClient.this.massUrl.replace("-", "").toLowerCase());
                } catch (Exception e) {
                    listener.onMessage("Registration failed: " + e.getMessage());
                }
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                try {
                    Log.d("MARelay", "Signaling message: " + text);
                    listener.onMessage("Signaling msg: " + text);
                    JSONObject msg = new JSONObject(text);
                    String type = msg.optString("type");
                    
                    if ("connected".equals(type) || "session-ready".equals(type)) {
                        listener.onMessage("Signaling session opened");
                        RfcommRelayClient.this.sessionId = msg.optString("sessionId");
                        JSONArray servers = msg.optJSONArray("iceServers");
                        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
                        if (servers != null) {
                            for (int i = 0; i < servers.length(); i++) {
                                try {
                                    JSONObject srv = servers.getJSONObject(i);
                                    Object urlsObj = srv.get("urls");
                                    PeerConnection.IceServer.Builder b;
                                    if (urlsObj instanceof JSONArray) {
                                        JSONArray urlsArr = (JSONArray) urlsObj;
                                        List<String> urlsList = new ArrayList<>();
                                        for (int j = 0; j < urlsArr.length(); j++) {
                                            urlsList.add(urlsArr.getString(j));
                                        }
                                        b = PeerConnection.IceServer.builder(urlsList);
                                    } else {
                                        b = PeerConnection.IceServer.builder(urlsObj.toString());
                                    }
                                    if (srv.has("username")) {
                                        b.setUsername(srv.getString("username"));
                                    }
                                    if (srv.has("credential")) {
                                        b.setPassword(srv.getString("credential"));
                                    }
                                    iceServers.add(b.createIceServer());
                                } catch (Exception e) {
                                    listener.onMessage("ICE server parse item error: " + e.getMessage());
                                }
                            }
                        }
                        if (iceServers.isEmpty()) {
                            iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
                        }
                        setupPeerConnection(iceServers);
                    } else if ("answer".equals(type)) {
                        RfcommRelayClient.this.sessionId = msg.optString("sessionId");
                        JSONObject data = msg.getJSONObject("data");
                        String sdp = data.getString("sdp");
                        SessionDescription desc = new SessionDescription(
                                SessionDescription.Type.ANSWER, sdp);
                        peerConnection.setRemoteDescription(new SdpObserver() {
                            @Override
                            public void onCreateSuccess(SessionDescription s) {}
                            @Override
                            public void onSetSuccess() {
                                listener.onMessage("Remote description set");
                            }
                            @Override
                            public void onCreateFailure(String s) {}
                            @Override
                            public void onSetFailure(String s) {
                                listener.onMessage("Remote description failed: " + s);
                            }
                        }, desc);
                    } else if ("ice-candidate".equals(type)) {
                        JSONObject data = msg.getJSONObject("data");
                        String candidate = data.getString("candidate");
                        String sdpMid = data.getString("sdpMid");
                        int sdpMLineIndex = data.getInt("sdpMLineIndex");
                        IceCandidate cand = new IceCandidate(sdpMid, sdpMLineIndex, candidate);
                        peerConnection.addIceCandidate(cand);
                    }
                } catch (Exception e) {
                    listener.onMessage("Signaling parse error: " + e.getMessage());
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                listener.onMessage("Signaling error: " + t.getMessage());
                reportTransportFailure(new IOException("Signaling error: " + t.getMessage(), t));
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                listener.onMessage("Signaling closed: " + reason);
                if (socket != null) {
                    reportTransportFailure(new IOException("Signaling closed: " + reason));
                }
            }
        });
    }

    private void setupPeerConnection(List<PeerConnection.IceServer> iceServers) {
        PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
        rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        
        PeerConnection.Observer pcObserver = new PeerConnection.Observer() {
            @Override
            public void onSignalingChange(PeerConnection.SignalingState newState) {}

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState newState) {
                listener.onMessage("ICE connection: " + newState);
                if (newState == PeerConnection.IceConnectionState.CONNECTED) {
                    listener.onStatus("Remote connection active");
                } else if (newState == PeerConnection.IceConnectionState.DISCONNECTED || newState == PeerConnection.IceConnectionState.FAILED) {
                    listener.onStatus("Remote connection lost");
                    if (newState == PeerConnection.IceConnectionState.FAILED) {
                        reportTransportFailure(new IOException("WebRTC ICE failed"));
                    }
                }
            }

            @Override
            public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
                listener.onMessage("WebRTC connection state: " + newState);
                if (newState == PeerConnection.PeerConnectionState.FAILED ||
                        newState == PeerConnection.PeerConnectionState.CLOSED) {
                    reportTransportFailure(new IOException("WebRTC connection " + newState));
                }
            }

            @Override
            public void onIceCandidateError(org.webrtc.IceCandidateErrorEvent event) {
                listener.onMessage("ICE candidate error: " + event.errorText);
            }

            @Override
            public void onIceConnectionReceivingChange(boolean receiving) {}

            @Override
            public void onIceGatheringChange(PeerConnection.IceGatheringState newState) {}

            @Override
            public void onIceCandidate(IceCandidate candidate) {
                try {
                    JSONObject msg = new JSONObject();
                    msg.put("type", "ice-candidate");
                    msg.put("remoteId", RfcommRelayClient.this.massUrl.replace("-", "").toLowerCase());
                    if (RfcommRelayClient.this.sessionId != null) {
                        msg.put("sessionId", RfcommRelayClient.this.sessionId);
                    }
                    JSONObject candData = new JSONObject();
                    candData.put("candidate", candidate.sdp);
                    candData.put("sdpMid", candidate.sdpMid);
                    candData.put("sdpMLineIndex", candidate.sdpMLineIndex);
                    msg.put("data", candData);
                    
                    if (signalingWebSocket != null) {
                        signalingWebSocket.send(msg.toString());
                    }
                } catch (Exception e) {
                    listener.onMessage("ICE send error: " + e.getMessage());
                }
            }

            @Override
            public void onIceCandidatesRemoved(IceCandidate[] candidates) {}

            @Override
            public void onAddStream(MediaStream stream) {}

            @Override
            public void onRemoveStream(MediaStream stream) {}

            @Override
            public void onDataChannel(DataChannel dataChannel) {}

            @Override
            public void onRenegotiationNeeded() {}

            @Override
            public void onAddTrack(RtpReceiver receiver, MediaStream[] mediaStreams) {}
        };
        
        peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, pcObserver);
        
        // Create the "ma-api" DataChannel
        DataChannel.Init init = new DataChannel.Init();
        init.ordered = true;
        final DataChannel dataChannel = peerConnection.createDataChannel("ma-api", init);
        webrtcDataChannel = dataChannel;
        
        dataChannel.registerObserver(new DataChannel.Observer() {
            @Override
            public void onBufferedAmountChange(long previousAmount) {}

            @Override
            public void onStateChange() {
                DataChannel.State state = dataChannel.state();
                listener.onMessage("DataChannel: " + state);
                if (state == DataChannel.State.OPEN) {
                    listener.onStatus("Connected to Music Assistant");
                } else if (state == DataChannel.State.CLOSED) {
                    reportTransportFailure(new IOException("WebRTC data channel closed"));
                }
            }

            @Override
            public void onMessage(DataChannel.Buffer buffer) {
                ByteBuffer data = buffer.data;
                byte[] bytes = new byte[data.remaining()];
                data.get(bytes);
                
                try {
                    String text = new String(bytes, StandardCharsets.UTF_8);
                    if (text.trim().startsWith("{")) {
                        JSONObject resp = new JSONObject(text);
                        if ("http-proxy-response".equals(resp.optString("type"))) {
                            String proxyId = resp.getString("id");
                            Long bluetoothReqId = pendingImageRequests.remove(proxyId);
                            if (bluetoothReqId != null) {
                                int status = resp.optInt("status", 200);
                                if (status >= 200 && status < 300) {
                                    String hexBody = resp.optString("body", "");
                                    byte[] bodyBytes = hexStringToByteArray(hexBody);
                                    sendFrame(new RelayFrame(RelayProtocol.IMAGE_DATA, 0, bluetoothReqId, bodyBytes));
                                } else {
                                    sendFrame(new RelayFrame(RelayProtocol.ERROR, 0, bluetoothReqId, ("HTTP " + status).getBytes(StandardCharsets.UTF_8)));
                                }
                            }
                            return;
                        }
                    }
                } catch (Exception ignored) {
                }
                
                send(RelayProtocol.WS_TEXT, bytes);
            }
        });
        
        // Create Offer
        MediaConstraints constraints = new MediaConstraints();
        peerConnection.createOffer(new SdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sdp) {
                peerConnection.setLocalDescription(new SdpObserver() {
                    @Override
                    public void onCreateSuccess(SessionDescription s) {}
                    @Override
                    public void onSetSuccess() {
                        try {
                            JSONObject msg = new JSONObject();
                            msg.put("type", "offer");
                            msg.put("remoteId", RfcommRelayClient.this.massUrl.replace("-", "").toLowerCase());
                            if (RfcommRelayClient.this.sessionId != null) {
                                msg.put("sessionId", RfcommRelayClient.this.sessionId);
                            }
                            JSONObject sdpData = new JSONObject();
                            sdpData.put("type", "offer");
                            sdpData.put("sdp", sdp.description);
                            msg.put("data", sdpData);
                            
                            if (signalingWebSocket != null) {
                                signalingWebSocket.send(msg.toString());
                            }
                        } catch (Exception e) {
                            listener.onMessage("Offer send error: " + e.getMessage());
                        }
                    }
                    @Override
                    public void onCreateFailure(String s) {}
                    @Override
                    public void onSetFailure(String s) {}
                }, sdp);
            }

            @Override
            public void onSetSuccess() {}
            @Override
            public void onCreateFailure(String s) {
                listener.onMessage("Offer create error: " + s);
            }
            @Override
            public void onSetFailure(String s) {}
        }, constraints);
    }

    private static byte[] hexStringToByteArray(String s) {
        int len = s.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(s.charAt(i), 16) << 4)
                                 + Character.digit(s.charAt(i+1), 16));
        }
        return data;
    }

    @Override
    public void close() {
        closing = true;
        closeSocket();
        closeWebSocket();
        if (peerConnectionFactory != null) {
            try {
                peerConnectionFactory.dispose();
            } catch (Exception e) {}
            peerConnectionFactory = null;
        }
        executor.shutdownNow();
        listener.onStatus("Disconnected");
    }
}
