// Magic Helper — Service Worker (self-destruct version)
// Rydder alle caches og afregistrerer sig selv så appen altid henter frisk indhold

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.map(k => caches.delete(k))))
            .then(() => self.registration.unregister())
    );
});
