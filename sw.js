'use strict';
const CACHE = 'simtara-shell-v2';
const BERKAS = [
  './', './index.html', './app.js', './config.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png'
];
self.addEventListener('install', evt => {
  evt.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(BERKAS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', evt => {
  evt.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('simtara-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', evt => {
  const req=evt.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  // Jangan meng-cache permintaan ke Apps Script/Google ataupun identitas siswa.
  if(url.origin!==self.location.origin) return;
  if(req.mode==='navigate') {
    evt.respondWith(fetch(req).then(resp=>{
      if(resp.ok){const cp=resp.clone();caches.open(CACHE).then(c=>c.put('./index.html',cp));}
      return resp;
    }).catch(()=>caches.match('./index.html')));
    return;
  }
  evt.respondWith(caches.match(req).then(cached => cached || fetch(req).then(resp=>{
    if(resp.ok && resp.type==='basic') {
      const cp=resp.clone();caches.open(CACHE).then(c=>c.put(req,cp));
    }
    return resp;
  })));
});
