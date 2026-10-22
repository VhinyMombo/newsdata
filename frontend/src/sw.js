import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { clientsClaim } from 'workbox-core'
import { registerRoute } from 'workbox-routing'
import { NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

// registerType 'autoUpdate': a new deploy takes over at once instead of
// waiting for every open tab to close, which kept old builds on screen
self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Same policy as the previous generateSW config: read endpoints get a short
// cached fallback for flaky connections, nothing is cached indefinitely.
registerRoute(
  ({ url }) => url.pathname.startsWith('/api'),
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 8,
    plugins: [
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 300 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
)

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch { /* non-JSON payload, ignore */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Le Kiosque', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus()
      }
      return self.clients.openWindow(url)
    })
  )
})
