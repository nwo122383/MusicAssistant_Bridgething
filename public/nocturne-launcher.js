(function () {
  var MA_URL = "/music-assistant/index.html?hardware=carthing";
  var DEFAULT_CONFIG_URL = "/music-assistant-default.json";
  var BYPASS_QUERY = "carthingMaBypass=1";
  var BYPASS_STORAGE_KEY = "carthing-ma-default-bypass";

  function bypassDefaultForThisSession() {
    try {
      if (window.location.search.indexOf(BYPASS_QUERY) >= 0) {
        window.sessionStorage.setItem(BYPASS_STORAGE_KEY, "1");
        return true;
      }
      return window.sessionStorage.getItem(BYPASS_STORAGE_KEY) === "1";
    } catch (_error) {
      return window.location.search.indexOf(BYPASS_QUERY) >= 0;
    }
  }

  function maybeOpenDefault() {
    if (window.location.pathname.indexOf("/music-assistant") === 0) return;
    if (bypassDefaultForThisSession()) return;

    try {
      var request = new XMLHttpRequest();
      request.open("GET", DEFAULT_CONFIG_URL, true);
      request.onreadystatechange = function () {
        if (request.readyState !== 4) return;
        if (request.status < 200 || request.status >= 300) return;
        try {
          var config = JSON.parse(request.responseText || "{}");
          if (config.defaultToMusicAssistant === true) {
            window.location.replace(MA_URL);
          }
        } catch (_error) {
          // Ignore malformed config and leave Nocturne available.
        }
      };
      request.send();
    } catch (_error) {
      // Ignore browser/network errors and leave Nocturne available.
    }
  }

  function installLauncher() {
    if (window.location.pathname.indexOf("/music-assistant") === 0) return;
    if (document.getElementById("carthing-ma-launcher")) return;

    var button = document.createElement("button");
    button.id = "carthing-ma-launcher";
    button.type = "button";
    button.textContent = "MA";
    button.title = "Open Music Assistant";
    button.setAttribute("aria-label", "Open Music Assistant");
    button.style.cssText = [
      "position:fixed",
      "right:72px",
      "top:264px",
      "z-index:2147483647",
      "width:52px",
      "height:52px",
      "padding:0",
      "border:2px solid rgba(255,255,255,.28)",
      "border-radius:26px",
      "box-shadow:0 8px 24px rgba(0,0,0,.5)",
      "background:#65e6a7",
      "color:#07110d",
      "font:700 16px/48px Arial,sans-serif",
      "text-align:center",
      "cursor:pointer"
    ].join(";");
    button.onclick = function (event) {
      event.preventDefault();
      event.stopPropagation();
      try {
        window.sessionStorage.removeItem(BYPASS_STORAGE_KEY);
      } catch (_error) {
        // Ignore storage failures.
      }
      window.location.href = MA_URL;
    };
    document.body.appendChild(button);
  }

  maybeOpenDefault();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installLauncher);
  } else {
    installLauncher();
  }
})();
