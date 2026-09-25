// Magic Helper — Service Worker
// Gør appen brugbar uden net: app-skallen og ikon-bibliotekerne caches,
// kortbilleder gemmes efterhånden som de ses. Live data (priser, søgning)
// hentes altid fra nettet og fejler pænt når forbindelsen mangler.

const VERSION   = 'v3';
const SHELL     = `mh-shell-${VERSION}`;   // selve appen
const VENDOR    = `mh-vendor-${VERSION}`;  // font-awesome, tesseract, mqtt m.fl.
const IMAGES    = 'mh-images';             // kortbilleder og sæt-ikoner
const IMAGE_CAP = 400;                     // maks antal gemte billeder
const NET_TIMEOUT = 2500;                  // ms vi venter på nettet før cachen bruges

const SHELL_FILES = [
    './',
    './index.html',
    './install.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// Font Awesome leverer alle ikoner i brugerfladen. Den skal hentes ned med det
// samme — ellers står appen uden ikoner, hvis første offline-brug sker før
// biblioteket tilfældigvis er blevet cachet undervejs.
const FA = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/';
const VENDOR_FILES = [
    FA + 'css/all.min.css',
    FA + 'webfonts/fa-solid-900.woff2',
    FA + 'webfonts/fa-regular-400.woff2'
];

// Biblioteker med fast versionsnummer i adressen — sikre at cache.
// esm.sh hører med: PaddleOCR hentes derfra, og uden den på listen blev
// tekstlæseren hentet forfra ved hver eneste scanning.
const VENDOR_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'];
// Billeder fra Scryfall — samme adresse giver altid samme billede
const IMAGE_HOSTS  = ['cards.scryfall.io', 'svgs.scryfall.io', 'c1.scryfall.com'];
// Levende data — må aldrig serveres fra cache
const LIVE_HOSTS   = ['api.scryfall.com', 'json.edhrec.com', 'open.er-api.com'];

self.addEventListener('install', event => {
    // addAll fejler hvis bare én fil mangler; tag dem enkeltvis, så en enkelt
    // utilgængelig fil ikke forhindrer resten i at blive gemt.
    const fill = (cacheName, files, init) => caches.open(cacheName).then(cache =>
        Promise.all(files.map(file =>
            cache.add(new Request(file, init)).catch(() => null)
        ))
    );
    event.waitUntil(
        Promise.all([
            fill(SHELL, SHELL_FILES, { cache: 'reload' }),
            fill(VENDOR, VENDOR_FILES, { mode: 'cors' })
        ]).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k.startsWith('mh-') && k !== SHELL && k !== VENDOR && k !== IMAGES)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Siden beder om at den nye version tages i brug med det samme
self.addEventListener('message', event => {
    if (event.data === 'skip-waiting') self.skipWaiting();
});

async function notifyClients(message) {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage(message));
}

// Hold billedcachen under kontrol — ældste ryger først
async function trimImages() {
    const cache = await caches.open(IMAGES);
    const keys = await cache.keys();
    if (keys.length <= IMAGE_CAP) return;
    await Promise.all(keys.slice(0, keys.length - IMAGE_CAP).map(k => cache.delete(k)));
}

// Appen selv: vis den gemte version med det samme, hent en ny i baggrunden.
// Baggrundshentningen skal holdes i live med waitUntil, ellers kan browseren
// lukke service workeren ned før den nye version er gemt.
async function handleShell(request, event) {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(request, { ignoreSearch: true })
                || await cache.match('./index.html');

    // Den gemte Response sendes videre til browseren, og dens body kan kun læses
    // én gang. Klon den med det samme, så baggrundssammenligningen har sin egen.
    const previousBody = cached ? cached.clone().text() : Promise.resolve(null);

    const network = (async () => {
        // NB: fetch(request, init) laver internt et nyt Request-objekt, og det er
        // ulovligt for en navigations-forespørgsel. Hent på adressen i stedet.
        const response = await fetch(new Request(request.url, { cache: 'no-cache' }));
        if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
        const fresh = await response.text();
        const init = {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        };
        // gem under begge nøgler, så både './' og './index.html' er opdaterede
        await cache.put('./', new Response(fresh, init));
        await cache.put('./index.html', new Response(fresh, init));
        return { fresh, init };
    })();

    // Nettet først, men med kort tålmodighed. Ellers ville en ny version først
    // blive vist ved NÆSTE besøg — og man ville sidde og teste den gamle app
    // uden at opdage det.
    const raced = await Promise.race([
        network.then(result => result, () => null),
        new Promise(resolve => setTimeout(() => resolve(null), NET_TIMEOUT))
    ]);
    if (raced) return new Response(raced.fresh, raced.init);

    // Nettet var væk eller for langsomt: vis den gemte version.
    if (!cached) {
        const slow = await network.catch(() => null);
        return slow ? new Response(slow.fresh, slow.init) : Response.error();
    }
    if (event) {
        event.waitUntil(network.then(async ({ fresh }) => {
            const previous = await previousBody;
            if (previous !== null && previous !== fresh) await notifyClients('update-ready');
        }).catch(() => {}));
    }
    return cached;
}

// Biblioteker og billeder: cache først, ellers hent og gem
async function cacheFirst(request, cacheName, afterPut) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;
    try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) {
            await cache.put(request, response.clone());
            if (afterPut) afterPut();
        }
        return response;
    } catch (error) {
        return hit || Response.error();
    }
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    let url;
    try { url = new URL(request.url); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;

    if (LIVE_HOSTS.includes(url.hostname)) return;          // altid fra nettet

    if (request.mode === 'navigate' || url.pathname.endsWith('.html')) {
        event.respondWith(handleShell(request, event));
        return;
    }
    if (VENDOR_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request, VENDOR));
        return;
    }
    if (IMAGE_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request, IMAGES, trimImages));
        return;
    }
    if (url.origin === self.location.origin) {
        event.respondWith(cacheFirst(request, SHELL));
    }
});
