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
