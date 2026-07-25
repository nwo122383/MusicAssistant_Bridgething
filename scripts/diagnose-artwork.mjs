const targets = await fetch("http://127.0.0.1:2222/json").then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");
if (!target) throw new Error("No Chromium page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const imageResponses = [];

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
  if (message.id && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
  if (message.method === "Network.responseReceived" && message.params?.response?.url.includes("imageproxy")) {
    const response = message.params.response;
    imageResponses.push({
      url: response.url,
      status: response.status,
      mimeType: response.mimeType,
      fromDiskCache: response.fromDiskCache,
      encodedDataLength: response.encodedDataLength,
    });
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

await command("Network.enable");
await command("Page.enable");
await command("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 3_000));

const evaluated = await command("Runtime.evaluate", {
  expression: `(function () {
    var artwork = document.querySelector('.artwork');
    var img = artwork && artwork.querySelector('img');
    var rect = artwork && artwork.getBoundingClientRect();
    var style = artwork && getComputedStyle(artwork);
    var imgStyle = img && getComputedStyle(img);
    return JSON.stringify({
      location: location.href,
      artwork: artwork ? {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        background: style.backgroundImage
      } : null,
      image: img ? {
        src: img.src,
        currentSrc: img.currentSrc,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        width: img.width,
        height: img.height,
        display: imgStyle.display,
        visibility: imgStyle.visibility,
        opacity: imgStyle.opacity,
        objectFit: imgStyle.objectFit
      } : null,
      nowPlaying: (function () {
        var title = document.querySelector('.track-copy h1');
        var artist = document.querySelector('.track-artist');
        var album = document.querySelector('.track-album');
        return {
          title: title ? title.textContent : null,
          artist: artist ? artist.textContent : null,
          album: album ? album.textContent : null
        };
      })(),
      resources: performance.getEntriesByType('resource')
        .filter(function (entry) { return entry.name.indexOf('imageproxy') !== -1; })
        .map(function (entry) { return { name: entry.name, duration: entry.duration, transferSize: entry.transferSize }; })
    });
  })()`,
  returnByValue: true,
});

socket.close();
console.log(JSON.stringify({
  dom: JSON.parse(evaluated.result.value),
  imageResponses,
}, null, 2));
