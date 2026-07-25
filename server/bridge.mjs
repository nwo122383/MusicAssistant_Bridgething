import express from "express";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configDirectory = join(root, ".carthing");
const configPath = join(configDirectory, "bridge-config.json");
const port = 4173;

let bridgeConfig = await readConfig();

async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return null;
  }
}

async function saveBridgeConfig(config) {
  await mkdir(configDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  bridgeConfig = config;
}

function loginToMusicAssistant(massUrl, username, password) {
  const wsUrl = `${massUrl.replace(/\/$/, "").replace(/^http/, "ws")}/ws`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const loginId = `bridge-login-${Date.now()}`;
    const authId = `bridge-auth-${Date.now()}`;
    let token;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Music Assistant login timed out"));
    }, 12_000);

    const fail = (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    socket.addEventListener("error", () => fail(new Error(`Unable to connect to ${massUrl}`)));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.server_id && message.server_version) {
        socket.send(JSON.stringify({
          message_id: loginId,
          command: "auth/login",
          args: { username, password, device_name: "Car Thing USB Bridge" },
        }));
        return;
      }
      if (message.message_id === loginId) {
        if (message.error_code) return fail(new Error(message.details || message.error_code));
        token = message.result?.access_token || message.result?.token;
        if (!token) return fail(new Error("Music Assistant did not return an access token"));
        socket.send(JSON.stringify({
          message_id: authId,
          command: "auth",
          args: { token, device_name: "Car Thing USB Bridge" },
        }));
        return;
      }
      if (message.message_id === authId) {
        if (message.error_code) return fail(new Error(message.details || message.error_code));
        clearTimeout(timeout);
        socket.close();
        resolve(token);
      }
    });
  });
}

const app = express();
app.use(express.json({ limit: "16kb" }));

app.get("/setup", (_request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Car Thing Setup</title><style>
body{font-family:system-ui;background:#0b0d10;color:#f5f6f7;max-width:620px;margin:50px auto;padding:24px}
form{display:grid;gap:16px;background:#171a20;padding:24px;border-radius:14px}label{display:grid;gap:6px}
input{font:inherit;padding:11px;border:1px solid #3b404a;border-radius:7px;background:#0e1014;color:white}
button{font:inherit;font-weight:700;padding:12px;border:0;border-radius:8px;background:#65e6a7;color:#07110d;cursor:pointer}
#status{min-height:24px;color:#aeb4be}.error{color:#ffabab}</style></head><body>
<h1>Car Thing Music Assistant</h1><p>Configure the USB bridge. The password is used once and is not stored.</p>
<form id="setup"><label>Music Assistant URL<input name="massUrl" required placeholder="http://192.168.1.50:8095"></label>
<label>Username<input name="username" required autocomplete="username"></label>
<label>Password<input name="password" required type="password" autocomplete="current-password"></label>
<button>Connect and provision Car Thing</button><div id="status"></div></form>
<script>
const form=document.getElementById('setup'),status=document.getElementById('status');
fetch('/api/status').then(r=>r.json()).then(s=>{if(s.configured)status.textContent='A bridge configuration is already saved.'});
form.addEventListener('submit',async event=>{event.preventDefault();status.className='';status.textContent='Connecting…';
const body=Object.fromEntries(new FormData(form));
try{const response=await fetch('/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Setup failed');status.textContent='Connected. Restart or reload the Car Thing preview.';form.password.value='';}catch(error){status.className='error';status.textContent=error.message;}});
</script></body></html>`);
});

app.get("/api/status", (_request, response) => {
  response.json({ configured: Boolean(bridgeConfig?.massUrl && bridgeConfig?.token), massUrl: bridgeConfig?.massUrl });
});

app.get("/api/device-config", (request, response) => {
  response.set("cache-control", "no-store");
  response.set("access-control-allow-origin", "*");
  if (!bridgeConfig?.token) return response.status(404).json({ configured: false });
  response.json({ serverUrl: `${request.protocol}://${request.get("host")}/mass`, token: bridgeConfig.token });
});

app.post("/api/setup", async (request, response) => {
  const { massUrl, username, password } = request.body || {};
  if (!massUrl || !username || !password) return response.status(400).json({ error: "All fields are required" });
  try {
    const normalizedUrl = String(massUrl).replace(/\/$/, "");
    const token = await loginToMusicAssistant(normalizedUrl, String(username), String(password));
    await saveBridgeConfig({ massUrl: normalizedUrl, token });
    response.json({ configured: true });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.use(express.static(join(root, "dist"), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

app.get("/{*path}", (_request, response) => {
  response.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  response.sendFile(join(root, "dist", "index.html"));
});

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });
proxy.on("error", (error, _request, response) => {
  if (response?.writeHead) {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`Music Assistant proxy error: ${error.message}`);
  }
});

const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/mass")) {
    if (!bridgeConfig?.massUrl) {
      response.writeHead(503, { "content-type": "text/plain" });
      return response.end("Bridge is not configured");
    }
    request.url = request.url.slice(5) || "/";
    return proxy.web(request, response, { target: bridgeConfig.massUrl });
  }
  app(request, response);
});

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/mass") || !bridgeConfig?.massUrl) return socket.destroy();
  request.url = request.url.slice(5) || "/";
  proxy.ws(request, socket, head, { target: bridgeConfig.massUrl });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Car Thing bridge: http://localhost:${port}`);
  console.log(`PC setup:        http://localhost:${port}/setup`);
});
