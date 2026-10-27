// paged-fetch.js — Supabase「一次读全量」的唯一分页实现（Data 层，§5 / §6 单一实现）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【为什么需要这个模块】
//   Supabase REST 单次响应上限 1000 行（实测 limit=12000 也只回 1000），页数无法消灭。
//   真正能改的是两件事：
//     ① 【别再串行】—— 逐页 await 时墙钟 = Σ单页耗时；并发取页后 = ~1 波。
//     ② 【别再先探总数】—— 老实现先发一条 `select=*&count=exact&head=true` 拿总行数，
//        在 4.7 万行的表上这条 COUNT 本身要 **5.8 秒**（2026-10-27 首屏实测），
//        而它唯一的作用只是「算出有几页」。绝大多数查询（首屏 30 天窗口）本来就不满一页。
//
// 【本模块的做法】
//   第 0 页单独取 ⇒ 不满一页立即返回（1 条请求，等价于「顺便探到了总数」）；
//   满一页才按 `concurrency` 并发扇出后续页，某一页不满即停。
//   ⇒ 小结果集 1 条请求（老实现 2 条 + 一次昂贵 COUNT）；大结果集 1 + ceil(n/并发) 波。
//
// 【红线】
//   §10 读取失败必须抛出，⛔ 绝不返回空数组冒充「没有数据」（调用方据此区分「读失败」与「确实为空」）。
//   §11 本模块只读，没有任何 delete / upsert。
//   ⚠️ 调用方传入的 `buildQuery` 必须是**每次新建**的 builder（supabase-js 的 builder 有内部状态）。
//
// 【已知限制 · 与改造前一致，非本次引入】
//   分页用 `.range()` 而不带 `.order()` 时，Postgres 不保证跨页顺序稳定（理论上边界行可能重复/漏）。
//   需要强一致顺序的调用方【必须】在 buildQuery 里自带 `.order(...)`（如 hot-stocks-cloud 的 hot 影子表）。
// ══════════════════════════════════════════════════════════════════════════════════════

const DEFAULT_PAGE_SIZE = 1000;
/** 默认并发 = 6，匹配浏览器对单域名的连接上限；后台补齐任务传更小的值（让步） */
const DEFAULT_CONCURRENCY = 6;
/** 硬闸：防止上游异常（永远回满页）导致无限翻页 */
const MAX_PAGES = 200;

/**
 * 把「一次逻辑读取」翻成有限并发的分页请求，返回全部行。
 *
 * @param {Function} buildQuery - () => Supabase query builder（已带 select 与过滤条件，每次新建）
 * @param {Object} [opts]
 *   · opts.pageSize    —— 每页行数，缺省 1000（Supabase 上限）
 *   · opts.concurrency —— 并发页数，缺省 6；后台任务传 2 以示让步
 * @returns {Promise<Array>} 全部行（顺序 = 页序 + 页内序；调用方不得依赖特定排序）
 */
export async function fetchAllPages(buildQuery, opts) {
  const pageSize = (opts && Number(opts.pageSize) > 0) ? Math.floor(Number(opts.pageSize)) : DEFAULT_PAGE_SIZE;
  const concurrency = (opts && Number(opts.concurrency) > 0) ? Math.max(1, Math.floor(Number(opts.concurrency))) : DEFAULT_CONCURRENCY;

  const rows = [];

  // ① 第 0 页：顺便充当「总数探测」——不满一页就说明已经取完
  const first = await buildQuery().range(0, pageSize - 1);
  if (first && first.error) throw first.error;
  const firstRows = (first && first.data) || [];
  rows.push.apply(rows, firstRows);
  if (firstRows.length < pageSize) return rows;

  // ② 第 1 页起：按 concurrency 一波一波扇出，任何一页不满即视为末页
  let nextPage = 1;
  while (nextPage < MAX_PAGES) {
    const wave = [];
    for (let j = 0; j < concurrency && (nextPage + j) < MAX_PAGES; j++) {
      const page = nextPage + j;
      wave.push(buildQuery().range(page * pageSize, (page + 1) * pageSize - 1));
    }
    const settled = await Promise.all(wave);
    let isLast = false;
    for (let k = 0; k < settled.length; k++) {
      const r = settled[k];
      if (r && r.error) throw r.error;
      const d = (r && r.data) || [];
      rows.push.apply(rows, d);
      if (d.length < pageSize) isLast = true;
    }
    if (isLast) return rows;
    nextPage += wave.length;
  }

  // 走到这里说明触到了 MAX_PAGES 硬闸 —— 必须让调用方知道「没取完」（§10）
  throw new Error('fetchAllPages 触及页数上限 ' + MAX_PAGES + '（已取 ' + rows.length + ' 行），未取完');
}

/** 仅供测试 / 诊断 */
export const PAGED_FETCH_LIMITS = { pageSize: DEFAULT_PAGE_SIZE, concurrency: DEFAULT_CONCURRENCY, maxPages: MAX_PAGES };
