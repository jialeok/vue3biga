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
 *   ② 页面导航（index.html）→ network-first，1.5 秒超时才回退缓存；
 *      ⇒ 网络正常且够快时永远拿最新 HTML；
 *      ⇒ 网络慢/断时用缓存兜底（不白屏），但**网络那条响应照样写回缓存**，
 *        且一旦发现线上 HTML 变了就通知页面弹「发现新版本」（SW-STALE-FIX 2026-11-01）；
 *   ③ 其它请求（Supabase 接口等）→ 完全不拦截，走原生网络（⛔ 绝不缓存业务数据）。
 * ============================================================================
 */
// ★★ [SW-STALE-FIX 2026-11-01] v1 → v2。
//   为什么必须换名字（不是习惯性递增）：v1 的导航分支有个真 bug（见下方 ② 的注释）——
//   超时回退时**网络响应被丢弃**，缓存里的旧 HTML 永远不会被更新。在「每个请求停顿 12~64 秒」
//   的网络下，等于把用户永久钉在发版前的那一版上（用户报障：「改了根本没生效」）。
//   换 cache 名 ⇒ activate 时把 biga-static-v1 整个删掉 ⇒ 下一次导航必然 cache-miss
//   ⇒ 直接走网络拿新 HTML ⇒ 一次刷新就脱离旧版本（代价：首屏资源要重下一次，值得）。
// ★★ [SW-STALE-FIX 2026-11-03] v2 → v3。
//   用户报障「第一页看不到同花顺最近多板那个数量」，而线上 bundle 里明明已有这段代码
//   （grep index-BmLs7Isv.js 命中「同花顺最近多板」）。根因就是本文件的网络特征：
//   导航 1.5s 超时 ⇒ 回退【v2 缓存里的旧 index.html】⇒ 旧 HTML 引用的是发版前的 JS 文件名
//   ⇒ 页面里根本没有那个标签。v2 的 bg 更新只解决了"下次会好"，解决不了"这次要看"。
//   再换一次缓存名 ⇒ 下一次导航 cache-miss ⇒ 必走网络拿当前 HTML ⇒ 立刻脱离旧版本。
//   ⚠️ 以后再出现「线上已换版但用户看不到」，先换这个版本号，别先去改业务逻辑。
var CACHE = 'biga-static-v41'; // [LD-CLOUD 2026-11-13] v40 → v41：第二十五条「总龙首次/二次分歧」改由【云端】预计算（Worker 9:27 + 16:00 落 tvrb_leader_diverge，前端只读一行注入 ebbCtx.leaderDiverge）⇒ 二次分歧按用户口径【等同首次退潮】，提示板会出现「〈题材〉二次分歧 · 等同退潮」。旧 v40 bundle 永远没有这条结论（它只认浏览器 K 线算出的首次分歧日）。⛔ 不升版本手机端会一直吃 v40 旧 JS
// 上一版 v39：[NEW-DRAGON-FAMILY-OLD + EBB-LINEAGE-FIRST + LEADER-DIVERGE 2026-11-12] v38 → v39：① 新题材候选【排除正在退潮的老题材】，且平局改成「新面孔多的优先 → 字辈线靠后」——上一版平局按成员数排，东方海洋同属【东方】和【羊字辈】两段时羊字辈(4只)压过东方(3只)，11-12 因此选出光洋股份/阳光照明；现在选【东方】，买点 = 东方海洋（竞价一字 → 挂「竞价一字涨停 · 等下杀买」）+ 大东方；② 退潮题材改锚【字辈线】（羊字辈 2 只），提示板写「羊字辈二次确认退潮」，⛔ 不再是「主线东方」；③ 退潮事件计数改按【同一只总龙 或 同题材线】认周期，题材改名不再把计数清零；④ 第二十五条新增首次/二次分歧口径（高开低走收绿、霸榜总龙一≥3天、二次分歧5日内≥2连板、二次分歧=首次退潮）。
// 上一版 v38：[NEW-DRAGON-FAMILY + TOPIC-LIB-FIRST] 第二十八条改成「新题材 = 字号/字辈题材」+ 题材库优先 + 改题材连历史一起重算 // [NEW-DRAGON-FAMILY + TOPIC-LIB-FIRST 2026-11-12] v37 → v38：① 第二十八条改成【新题材 = 字号/字辈题材】：当日 20日涨幅（9:25 竞价口径）前十按题材段分组，同题材 ≥2 只且含「新面孔」即为新题材；老龙换题材（双重属性）可入选并再补一只该题材的新面孔（11-12 = 东方海洋作认证 + 买大东方）；② 题材认亲改成【题材库优先】（用户手动改的题材说了算，历史 note 只作兜底）；③ 退潮「主线题材」支持字号/字辈题材 ≥2 只互相验证（11-10 羊字辈/东方系），行业题材仍 ≥3；④ 选股存档指纹新增「题材库内容指纹」——用户改题材后【连历史日期一起重算】。旧 v37 bundle 会按「工业4.0」选出福莱新材，并用当日 note 覆盖你手动整理的题材。⛔ 不升版本手机端会一直吃 v37 旧 JS
// 上一版 v37：卖点侧空态三态 + 认证龙（同题材择优 · 前五）
// 上一版 v36 [SELL-AUTO 2026-11-12]：卖点侧成员从「只认昨日『买入』标签」扩为「昨日买点侧自动继承 ∪ 手动买入 ∪ 手动持有，昨日『卖出』否决」——用户早上按买点侧买进去，次日不用再逐只补打标签。旧 v35 bundle 仍要求手动打标签，卖点侧会缺票。
// 上一版 v35 [SELL-LIVE 2026-11-12]：定稿冻结从「整份 plan」收窄为「只冻结买点选股结论」——卖点段（成员 = 用户昨天打的「买」标签，随时可补打）与分笔装饰（异步抓取）改为恒取实时。旧 v34 bundle 会把 09:28 定稿存档原样上屏 ⇒ 之后在历史日补打的买入标签永远进不了卖点列表、分笔永远显示「未抓取」。
// 上一版 v34 [BOARD-AUC-MEMBERS-2 2026-11-11]：v33 只在「首次进入就按 close 口径算」时生效——本模块开头有一条会话缓存早退 `if (_cache.has(date)) return`，而竞价口径成员榜是在精算段**末尾**才算的 ⇒ 只要这一天先前算过一次（切 20日 toggle / 切日期回来），就永远走不到那段 ⇒ 盘后仍回落收盘口径、青岛食品仍不显示（「有时显示有时不显示」比不修更难查）。本版新增 `_boardTried` 集合 + 早退判据 `_needBoard`，保证盘后最多多跑一次（§32）。⛔ 不升版本手机端会一直吃 v33 旧 JS
// 上一版 v30 [TVRB-PLAN-SNAPSHOT]：题材量比【选股结论按日落库】。旧 v29 bundle 的结论只在内存 _buyPublished ⇒ 切日期解冻重算，且历史日门控跳过竞价口径榜 ⇒ 早盘那份结论被中间态冻结覆盖（「历史日期复盘冰山冷热又搞失踪」）。
// 上一版 v29 [DDL-LEG]：stock_range20_pct 主键升级 (date,stock,leg) 后改为「byLeg 两腿并存 + 按口径取行 + upsert 冲突键带 leg」；旧 v28 bundle 写两列 on_conflict ⇒ 400/42P10 ⇒ 当天结果表 0 行、前端退回浏览器现算 40+ 次 K 线（出结果慢）。
// ★★ [BOOT-SW-NAVFAST 2026-10-31] 从 4000 收到 1500。
//   原因（实测）：这台机器的网络特征是「每个请求固定停顿 12~64 秒」（3.7KB 的 sw.js 要 64s），
//   装好 SW 之后每次打开仍然要等「导航请求」这一次停顿 ⇒ 就是这 4 秒在拖。
//   改成 1.5s：网络正常时照样拿最新 HTML（通常 <0.3s），网络卡时 1.5s 就回退本地缓存。
//   ⚠️ 超时后那条网络请求【不会取消】，它的响应会被写回缓存并触发「发现新版本」提示
//      —— 这一点在 v1 里是**坏的**（响应被丢弃，缓存永不更新），2026-11-01 已修，
//      见下方 fetch 处理器 ② 段的注释。⛔ 别再把「后台请求」的 .then 挂到 Promise.race 上。
var NAV_TIMEOUT_MS = 1500;

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
    }).then(function () { return self.clients.claim(); }).then(function () {
      return prefetchShell();
    })
  );
});

/* ★★ [SW-STALE-FIX 2026-11-01] 激活即把【当前线上 HTML】写进新缓存。
 * 为什么必须做（这是「一次就能到新版」的关键）：
 *   换 cache 名之后新缓存是空的，而页面导航是「network-first + 1.5 秒超时回退缓存」。
 *   在「每个请求停顿 12~64 秒」的网络下，超时必然发生 ⇒ 回退时缓存是空的 ⇒ 只能再等一次网络。
 *   激活时先把 HTML 抓好放进缓存，则**下一次打开就直接命中新 HTML** ⇒ 用户不必开两三次。
 * ⛔ 只抓外壳 HTML（同源、无业务数据）；失败一律吞掉（不影响任何功能）。 */
function prefetchShell() {
  try {
    var u = new URL(self.registration.scope);
    var key = new Request(u.origin + u.pathname);
    return caches.open(CACHE).then(function (cache) {
      return fetch(new Request(key, { cache: 'no-cache' })).then(function (res) {
        if (res && res.ok) return cache.put(key, res.clone());
        return null;
      });
    }).catch(function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

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
    // 缓存键归一化成「origin + pathname」：`autoReloadOnce` 的 `?r=<时间戳>` 每次都不一样，
    // 不归一化就会在缓存里堆出一串只有查询串不同的副本（越用越大，还都匹配不上）。
    var navKey = (function () { try { return new Request(url.origin + url.pathname); } catch (e) { return req; } })();
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        var timer = 0;
        // ★★★ [SW-STALE-FIX 2026-11-01 用户报障「改了根本没生效」—— 这是一个真 bug，不是网络问题]
        //
        // 旧写法（v1）：
        //   `Promise.race([fetch(req), timeout]).then(res => cache.put(...))`
        //   ⇒ 超时先赢的话，race 直接进 catch 分支，**另一个分支的 `.then` 再也不会执行**
        //   ⇒ 那条「还在路上的网络响应」被【丢弃】，缓存永远是旧 HTML。
        //   而本机网络特征恰恰是「每个请求固定停顿 12~64 秒」（见 NAV_TIMEOUT_MS 注释）
        //   ⇒ 导航**每次都超时 1.5s** ⇒ 每次都吃旧 HTML ⇒ **新版本永远进不来**。
        //   原注释写的「后台那次 fetch 到货后仍会更新缓存」是错的（从未生效），已改掉。
        //
        // 现在：
        //   ① `net` 自己挂 `.then` —— 无论 race 谁赢，响应都一定写进缓存；
        //   ② 写入时对比新旧 HTML：变了 ⇒ 说明线上发版了 ⇒ postMessage 通知页面弹「发现新版本」；
        //   ③ `event.waitUntil(bg)` 保证 SW 在后台这条链跑完之前不被回收。
        //   ⛔ 只写本站 HTML，不碰业务数据（与文件头 ③ 一致）。
        var net = fetch(req);
        var bg = net.then(function (res) {
          if (!res || !res.ok) return null;
          // 克隆必须在任何 await 之前、且赶在页面消费 body 之前 —— bg 在 race 之前注册 ⇒ 先跑
          var copy = null;
          try { copy = res.clone(); } catch (e) { return null; }
          return cache.match(navKey).then(function (old) {
            if (!old) return cache.put(navKey, copy).then(function () { return 'first'; });
            return Promise.all([old.text(), copy.clone().text()]).then(function (pair) {
              var changed = pair[0] !== pair[1];
              return cache.put(navKey, copy).then(function () { return changed ? 'changed' : 'same'; });
            });
          }).catch(function () { return null; });
        }).then(function (state) {
          if (state === 'changed') return notifyNewVersion();
          return null;
        }).catch(function () { return null; });
        if (event.waitUntil) event.waitUntil(bg);

        var timeout = new Promise(function (_, reject) {
          timer = setTimeout(function () { reject(new Error('nav-timeout')); }, NAV_TIMEOUT_MS);
        });
        return Promise.race([net, timeout]).then(function (res) {
          clearTimeout(timer);
          // 网络赢了 ⇒ 页面拿到的就是新 HTML，无需再通知（bg 仍会顺手把缓存更新掉）
          return res;
        }).catch(function () {
          clearTimeout(timer);
          return cache.match(navKey).then(function (hit) {
            // 有缓存就先用缓存（能立刻看见界面，比白屏强）；
            // 若线上已经换版，bg 会在几秒后弹「发现新版本」（见上）
            if (hit) return hit;
            // 没缓存 ⇒ 宁可再等一次网络，也不要白屏
            return fetch(req);
          });
        });
      })
    );
  }
});

/** 通知所有受控页面「线上已发版」（页面侧弹一条可点刷新的小横条，见 index.html） */
function notifyNewVersion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) {
      try { c.postMessage({ type: 'NEW_VERSION' }); } catch (e) {}
    });
  }).catch(function () { return null; });
}
