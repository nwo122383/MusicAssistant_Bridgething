const targets = await fetch("http://127.0.0.1:2222/json").then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");

if (!target) throw new Error("No Chromium page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("DevTools response timed out")), 5000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: `(function () {
          var root = document.getElementById("root");
          return JSON.stringify({
            readyState: document.readyState,
            title: document.title,
            bodyText: document.body.innerText,
            rootHtml: root ? root.innerHTML : null,
            scripts: Array.prototype.map.call(document.scripts, function (script) { return script.src; }),
            resources: performance.getEntriesByType("resource").map(function (resource) {
              return { name: resource.name, transferSize: resource.transferSize, duration: resource.duration };
            })
          });
        })()`,
        returnByValue: true,
      },
    }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timeout);
    resolve(message.result?.result?.value ?? message);
  });
  socket.addEventListener("error", reject);
});

socket.close();
if (typeof result === "string") {
  console.log(JSON.stringify(JSON.parse(result), null, 2));
} else {
  console.log(JSON.stringify(result, null, 2));
}
