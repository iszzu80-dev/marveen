// Self-unregistering service worker (kill-switch).
//
// An earlier network-first SW could resolve FetchEvent.respondWith to null on a
// cache miss ("Returned response is null"), which broke the dashboard on iOS
// (notably the ?token= entry URL, reached via Tailscale Serve). Rather than ship
// another caching SW, this version DISABLES service-worker interception entirely:
// it has NO fetch handler, so every request goes straight to the network, and on
// activate it unregisters itself, purges all caches, and reloads open tabs so a
// stuck old SW self-heals on the next visit. The dashboard is a localhost/tailnet
// tool that does not need offline caching, so removing the SW is the safe fix.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* cache purge is best-effort */
      }
      try {
        await self.registration.unregister();
      } catch {
        /* unregister is best-effort */
      }
      // Reload any open tabs so the now-unregistered SW stops intercepting.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try { client.navigate(client.url); } catch { /* ignore */ }
      }
    })()
  );
});

// NO fetch handler on purpose: requests are not intercepted at all.
