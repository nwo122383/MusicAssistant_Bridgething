const targets = await fetch("http://127.0.0.1:2222/json").then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");
if (!target) throw new Error("No Chromium page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Reload timed out")), 5000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method: "Page.reload", params: { ignoreCache: true } }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) {
      clearTimeout(timeout);
      resolve();
    }
  });
  socket.addEventListener("error", reject);
});
socket.close();
console.log("Car Thing page reloaded");
