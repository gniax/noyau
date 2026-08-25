// Filet de securite: si le bundle React ne monte pas (cache casse, asset manquant),
// on affiche un panneau de recuperation. CSP interdit le script inline, d'ou ce fichier.
(function () {
  var DELAY = 8000;

  function reset() {
    var jobs = [];
    if (window.caches && caches.keys) jobs.push(caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) { return caches.delete(key); }));
    }));
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (list) {
        return Promise.all(list.map(function (registration) { return registration.unregister(); }));
      }));
    }
    Promise.all(jobs).catch(function () {}).then(function () {
      location.replace("/?reset=" + Date.now());
    });
  }

  function render() {
    if (window.__noyauMounted) return;
    var host = document.querySelector(".preboot span");
    if (!host) return;
    var note = document.createElement("small");
    note.className = "preboot-note";
    note.textContent = "Le chargement bloque. Cache probablement corrompu.";
    var actions = document.createElement("div");
    actions.className = "preboot-actions";
    var retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Réessayer";
    retry.onclick = function () { location.reload(); };
    var purge = document.createElement("button");
    purge.type = "button";
    purge.className = "danger";
    purge.textContent = "Réinitialiser l’app";
    purge.onclick = reset;
    actions.appendChild(retry);
    actions.appendChild(purge);
    host.appendChild(note);
    host.appendChild(actions);
  }

  if (new URLSearchParams(location.search).has("reset")) history.replaceState(null, "", "/");
  setTimeout(render, DELAY);
})();
