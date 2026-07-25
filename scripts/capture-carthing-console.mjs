const targets = await fetch("http://127.0.0.1:2222/json").then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");
if (!target) throw new Error("No Chromium page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const events = [];

await new Promise((resolve, reject) => {
  const timeout = setTimeout(resolve, 5000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    socket.send(JSON.stringify({ id: 2, method: "Log.enable" }));
    socket.send(JSON.stringify({ id: 3, method: "Page.enable" }));
    socket.send(JSON.stringify({ id: 4, method: "Page.reload", params: { ignoreCache: true } }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown" || message.method === "Log.entryAdded") {
      events.push(message);
    }
    if (message.method === "Page.loadEventFired") {
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 1500);
    }
  });
  socket.addEventListener("error", reject);
});

socket.close();
console.log(JSON.stringify(events, null, 2));
