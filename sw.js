/* Service worker mínimo: permite mostrar notificaciones y abrir la página al tocarlas.
   No guarda copias de la página, así siempre se carga la versión más nueva. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ("focus" in list[i]) { list[i].navigate && list[i].navigate(url).catch(function () {}); return list[i].focus(); }
    }
    return self.clients.openWindow ? self.clients.openWindow(url) : null;
  }));
});

/* Avisos que manda el servidor (GitHub Actions) aunque la página esté cerrada */
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Café Frío", {
    body: d.body || "", tag: d.tag || "cafe-frio", icon: "assets/icon-192.png", badge: "assets/icon-192.png",
    data: { url: d.url || "./" }
  }));
});
