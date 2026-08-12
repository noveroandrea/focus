// ─────────────────────────────────────────────────────────────────────────────
//  The service worker — the part that is awake when nothing else is
// ─────────────────────────────────────────────────────────────────────────────
//  This is why the pairing page has to be a real web app on HTTPS rather than a page
//  inside the extension: a push arrives when the phone is locked, the app is closed
//  and the browser is not running. The operating system wakes the browser, the
//  browser wakes this worker, and this worker draws the notification. Nothing else in
//  the chain is alive at that moment.
//
//  It deliberately does NOT cache anything or claim to work offline. The page it
//  serves is a one-time setup flow — caching it would only mean showing a stale
//  version of instructions to somebody re-pairing months later.
// ─────────────────────────────────────────────────────────────────────────────

// Take over as soon as installed rather than waiting for every tab to close. The
// pairing flow registers this worker and subscribes seconds later, and a subscription
// created against a worker still in `waiting` is a subscription with nobody home.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // A payload is always sent, but never trusted to arrive intact: an empty push (a
  // service that dropped the body, a future sender that stops encrypting one) must
  // still produce a notification, because Chrome punishes a push that shows none —
  // repeatedly, by revoking the permission.
  let title = 'Focus';
  let body = 'You have gone idle.';
  try {
    if (event.data) {
      const data = event.data.json();
      if (typeof data.title === 'string') title = data.title;
      if (typeof data.body === 'string') body = data.body;
    }
  } catch { /* not JSON — keep the defaults */ }

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // One tag, so a second nudge REPLACES the first rather than stacking. Coming back
    // to eleven identical notifications is how a person decides to turn a feature
    // off. `renotify` is what makes the replacement still buzz.
    tag: 'focus-idle',
    renotify: true,
    // Android honours this pattern (subject to the notification channel's own
    // settings); iOS ignores it and uses the system's own haptics. Harmless either
    // way, and it is the whole point of the feature where it is respected.
    vibrate: [200, 100, 200, 100, 300],
    // Deliberately not requireInteraction: the message is only meaningful for the
    // few seconds the warning lasts, so it should fade like any other alert rather
    // than sit on the lock screen until dismissed.
    requireInteraction: false,
  }));
});

// Tapping it opens (or focuses) the app. There is nothing to do there — the point of
// the tap is that you have picked the phone up, which is the moment you remember to
// put it down and get back to work.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow('./');
  })());
});
