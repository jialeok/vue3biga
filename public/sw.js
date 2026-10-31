/* sw.js — 首屏静态资源本地缓存（BOOT-SW 2026-10-31）
 * ============================================================================
 * 这个文件解决的是【一个具体的、可复现的问题】：「刷新两次才能打开页面」。
 *
 * 实测（2026-10-31，直连线上 URL）：
 *   · GitHub Pages 给 index.html 的是 `cache-control: max-age=600`（10 分钟）；
 *   · 给 /assets/*.js|css 的是 `max-age=14400`（4 小时）；
 *   · 从本机网络取 5 个首屏资源，最坏一次 CSS +19972ms、入口 JS +55689ms 才到货。
 *   ⇒ 只要隔了 4 小时以上（早上开盘正是这种情况）再打开，assets 缓存已过期 ⇒ 又是一轮
 *     20~56 秒的冷启动 ⇒ 看门狗误报红屏；紧接着再刷新一次命中磁盘缓存，就正常了。
 *   ⇒ 所以这不是「偶发」，是【每早必现两次】。
 *
 * Service Worker 的 Cache API **不受 max-age 约束**（只有浏览器配额/用户清缓存能清掉）：
 *   · 首次访问仍要走网络（这一趟快不了，除非换托管）；
 *   · 但从此以后每次打开 —— 包括隔夜、隔周 —— 都直接命中本地缓存，秒开。
 *
 * 策略（刻意做得保守，避免「缓存导致白屏」这个经典事故）：
 *   ① /assets/*（文件名带内容哈希 ⇒ 内容永不变）→ cache-first，命中即返回；
 *   ② 页面导航（index.html）→ network-first，4 秒超时才回退缓存；
 *      ⇒ 在线时永远拿最新 HTML，不会出现「新版本部署了但一直吃旧页面」；
 *      ⇒ 网络慢/断时才用缓存兜底，而不是白屏；
 *   ③ 其它请求（Supabase 接口等）→ 完全不拦截，走原生网络（⛔ 绝不缓存业务数据）。
 * ============================================================================
 */
var CACHE = 'biga-static-v1';
var NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', function () {
  // 新版立即待命，不等旧页面全部关闭（否则用户要开两次才生效）
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k.indexOf('biga-') === 0 && k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

/* ★★ [BOOT-SW-WARM 2026-10-31] 首次访问的预热入口。
 * 为什么需要：SW 是在 `load` + 空闲时注册的，而首屏 5 个资源**那时已经下载完了** ⇒
 *   fetch 处理器一条都没看到 ⇒ 缓存是空的 ⇒ 「首访之后断网打不开 / 第二次打开也不快」。
 * 页面侧把「本次实际用到的资源 URL」发过来，这里补齐写入 ⇒ 首访当晚就完成预热。
 * ⛔ 全部走 cache.add（命中 HTTP 缓存时不再产生网络流量），失败逐条吞掉（单个资源失败不影响其它）。 */
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type !== 'WARM' || !Array.isArray(data.urls) || data.urls.length === 0) return;
  var job = caches.open(CACHE).then(function (cache) {
    return Promise.all(data.urls.map(function (u) {
      return cache.add(u).catch(function () { return null; });
    }));
  });
  if (event.waitUntil) event.waitUntil(job);
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  // ⛔ 只处理本站静态资源：跨域（Supabase / 同花顺代理）一律不碰，避免缓存业务数据
  if (url.origin !== self.location.origin) return;

  // ① 构建产物（带内容哈希）→ cache-first
  if (url.pathname.indexOf('/assets/') >= 0) {
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  // ② 页面导航（HTML）→ network-first + 超时回退缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        var timer = 0;
        var timeout = new Promise(function (_, reject) {
          timer = setTimeout(function () { reject(new Error('nav-timeout')); }, NAV_TIMEOUT_MS);
        });
        return Promise.race([fetch(req), timeout]).then(function (res) {
          clearTimeout(timer);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () {
          clearTimeout(timer);
          return cache.match(req).then(function (hit) {
            // 有缓存就先用缓存（能立刻看见界面，比白屏强）
            if (hit) return hit;
            // 没缓存 ⇒ 宁可再等一次网络，也不要白屏
            return fetch(req);
          });
        });
      })
    );
  }
});
