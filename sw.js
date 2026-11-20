/* 앱 껍데기(HTML·CSS·JS·아이콘)만 담는다.
 * 실제 데이터(게시글·댓글)는 여기에 캐시하지 않는다 — IndexedDB에만 담긴다.
 *
 * 껍데기는 '네트워크 먼저, 실패하면 캐시'로 받는다.
 * (HTML만 새로 받고 JS/CSS는 옛 캐시로 쓰면 화면이 깨지기 때문 — 버전을 올려도
 *  새 워커가 활성화되기 전 첫 방문에서 그런 어긋남이 생긴다.)
 */
var VERSION = 'neis-archive-v6';
var SHELL = [
  './',
  './index.html',
  './styles.css?v=6',
  './app.js?v=6',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === VERSION ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // 연결 주소(POST)는 그대로 네트워크로
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;             // 외부 요청은 손대지 않음

  /* no-cache: GitHub Pages 의 10분 HTTP 캐시에 옛 JS/CSS 가 남아
     새 HTML과 어긋나는 것을 막는다. 서버가 그대로면 304로 끝난다. */
  var net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    if (res && res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { c.put(req, copy); }).catch(function () {});
    }
    return res;
  });

  e.respondWith(
    net.catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
