const targets = await fetch("http://127.0.0.1:2222/json").then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");
if (!target) throw new Error("No Chromium page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10_000);
  });
}

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

await command("Runtime.evaluate", {
  expression: `(function () {
    var launcher = document.getElementById('carthing-ma-launcher');
    if (!launcher) throw new Error('Nocturne MA launcher was not found');
    launcher.click();
  })()`,
});
await new Promise((resolve) => setTimeout(resolve, 4_000));

const appResult = await command("Runtime.evaluate", {
  expression: `(function () {
    var connection = document.querySelector('.connection');
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.navrail button'));
    return JSON.stringify({
      path: location.pathname,
      title: document.title,
      connection: connection ? connection.textContent.trim() : null,
      hasNocturneButton: buttons.some(function (button) { return button.textContent.trim() === 'Nocturne'; }),
      bodyText: document.body.innerText.slice(0, 500)
    });
  })()`,
  returnByValue: true,
});
const app = JSON.parse(appResult.result.value);

await command("Runtime.evaluate", {
  expression: `(function () {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.navrail button'));
    var button = buttons.filter(function (entry) { return entry.textContent.trim() === 'Nocturne'; })[0];
    if (!button) throw new Error('Music Assistant Nocturne button was not found');
    button.click();
  })()`,
});
await new Promise((resolve) => setTimeout(resolve, 2_500));

const nocturneResult = await command("Runtime.evaluate", {
  expression: `(function () {
    var launcher = document.getElementById('carthing-ma-launcher');
    var rect = launcher && launcher.getBoundingClientRect();
    return JSON.stringify({
      path: location.pathname,
      title: document.title,
      hasLauncher: !!launcher,
      launcherRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
    });
  })()`,
  returnByValue: true,
});
const nocturne = JSON.parse(nocturneResult.result.value);

socket.close();
console.log(JSON.stringify({ app, nocturne }, null, 2));

if (!app.path.startsWith("/music-assistant/") || !app.hasNocturneButton) process.exitCode = 1;
if (nocturne.path !== "/" || !nocturne.hasLauncher) process.exitCode = 1;
