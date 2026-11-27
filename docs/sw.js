/*
 * Domain X-Ray & DNS Status (url-status) - Service Worker (PWA)
 * Copyright © 2026 Gerivan Costa dos Santos
 * GitHub: https://github.com/gerivanc/url-status
 * MIT License: https://github.com/gerivanc/url-status/blob/main/LICENSE
 * Version: 1.0.3
 *
 * Purpose:
 *   - Makes the satellite installable as a Progressive Web App (browsers
 *     require a registered service worker with a fetch handler).
 *   - Lets the page shell (HTML, icons, manifest) open even without a
 *     connection, so the installed app always launches.
 *
 * Security / data-freshness notes:
 *   - Only same-origin GET requests are handled. Every scan the page makes
 *     (DNS-over-HTTPS, RDAP, Certificate Transparency, BGP, the 24/7 monitor
 *     telemetry on raw.githubusercontent.com...) is cross-origin and is left
 *     to the browser untouched: live results are NEVER served from cache.
 *   - Requests carrying a query string other than the PWA markers
 *     (?source=..., ?domain=..., share target) are not stored, so the cache
 *     cannot grow without bound.
 */

'use strict';

// Bump this value on every release so old caches are discarded.
const CACHE_VERSION = 'url-status-v1.0.3';

// Core application shell. Required entries must exist or installation fails.
const REQUIRED_ASSETS = [
    './',
    './index.html',
    './site.webmanifest'
];

// Nice-to-have assets. A missing file here must NOT break installation,
// so each one is cached individually and failures are ignored.
const OPTIONAL_ASSETS = [
    './favicon.svg',
    './favicon.ico',
    './favicon-16x16.png',
    './favicon-32x32.png',
    './favicon-96x96.png',
    './favicon-256x256.png',
    './apple-touch-icon.png',
    './web-app-manifest-192x192.png',
    './web-app-manifest-512x512.png',
    './web-app-manifest-maskable-192x192.png',
    './web-app-manifest-maskable-512x512.png'
];

// Install: pre-cache the application shell.
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_VERSION);
        await cache.addAll(REQUIRED_ASSETS);
        await Promise.all(
            OPTIONAL_ASSETS.map((url) => cache.add(url).catch(() => undefined))
        );
        // Activate the new worker immediately instead of waiting for all tabs to close.
        await self.skipWaiting();
    })());
});

// Activate: remove caches from previous versions and take control of open pages.
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((key) => key.startsWith('url-status-') && key !== CACHE_VERSION)
                .map((key) => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

// Fetch strategy:
//   - Page navigations: network first (always the latest release when
//     online), falling back to the cached shell when offline.
//   - Other same-origin assets (icons, manifest): stale-while-revalidate.
self.addEventListener('fetch', (event) => {
    const request = event.request;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(staleWhileRevalidate(request, event));
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_VERSION);
    try {
        const response = await fetch(request);
        if (response && response.ok) {
            // Store the page once, under its clean URL (no query string).
            cache.put('./', response.clone());
        }
        return response;
    } catch (error) {
        const cached = (await cache.match('./')) || (await cache.match('./index.html'));
        if (cached) return cached;
        throw error;
    }
}

async function staleWhileRevalidate(request, event) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request, { ignoreSearch: true });

    const networkUpdate = fetch(request)
        .then((response) => {
            if (response && response.ok && !new URL(request.url).search) {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => undefined);

    if (cached) {
        // Keep the worker alive until the background refresh completes.
        event.waitUntil(networkUpdate);
        return cached;
    }

    const response = await networkUpdate;
    return response || Response.error();
}
