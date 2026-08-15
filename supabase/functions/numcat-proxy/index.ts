// ===========================================================================
// numcat-proxy — Supabase Edge Function (Deno)
// 代理「猫抓 numcat」行情 / 情绪 / 选股接口，隐藏 API key（仅从 Deno.env 读取，绝不明文硬编码）。
//
// 前端调用契约（src/data/api/numcat-proxy.js）：
//   POST /functions/v1/numcat-proxy
//   请求体：{ apiname, fields, params, path? }
//   成功返回：{ code: 200, message: 'ok', data: <上游原始 JSON> }
//   失败返回：{ code: <非零>, message, data: null }  ← 前端据此 throw
//
// 上游（猫抓 numcat reference-proxy）：
//   POST https://numcat.net/api/reference-proxy/<path>
//   请求体：{ apiname, apikey, params, fields }
//   响应：  { code: 200, message, fields, items, ... }（成功码为 200）
//
// 部署（二选一）：
//   A. Dashboard：Functions → 新建 numcat-proxy → 粘贴本文件全部内容。
//   B. CLI：supabase functions deploy numcat-proxy  （本文件位置即 supabase/functions/numcat-proxy/index.ts）
// 部署后务必在 Secrets 里设置 NUMCAT_API_KEY（NUMCAT_BASE_URL 可选，默认 https://numcat.net/api/reference-proxy）。
// 函数设置：按需要决定是否关闭 Verify JWT（前端用 anon key 调用）。
// ===========================================================================

const NUMCAT_BASE_URL = (Deno.env.get('NUMCAT_BASE_URL') || 'https://numcat.net/api/reference-proxy').replace(/\/$/, '');
const NUMCAT_API_KEY = Deno.env.get('NUMCAT_API_KEY') || '';

// apiname → 上游 reference-proxy 子路径映射（来自仓库 worker 配置与前端调用）
const API_PATH_MAP: Record<string, string> = {
  daily_auc: 'stock/daily_auc',        // 竞价量（前端 numcatApiPost('daily_auc', ...)）
  daily: 'stock/daily',                // 收盘涨幅（前端 numcatApiPost('daily', ...)）
  emoindic_daily: 'market/emoindic-daily', // 情绪周期（worker B fetchNumCatEmotionFull）
  // TODO: 核实 screening / point_monitor 在 numcat reference-proxy 下的真实路径，
  //       当前按基准推测为 stock/screening、stock/point_monitor（前端确有 numcatApiPost('screening'/'point_monitor') 调用）。
  screening: 'stock/screening',
  point_monitor: 'stock/point_monitor',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/health') {
    return json({ ok: true, service: 'numcat-proxy' });
  }

  if (req.method !== 'POST') {
    return json({ code: -1, message: 'method not allowed', data: null }, 405);
  }

  if (!NUMCAT_API_KEY) {
    return json({ code: -1, message: 'NUMCAT_API_KEY 未配置（请在 Supabase Secrets 设置）', data: null }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ code: -1, message: 'invalid JSON body', data: null }, 400);
  }

  const apiname = body.apiname;
  const fields = body.fields;
  const params = body.params || {};
  const pathOverride = body.path;

  if (!apiname && !pathOverride) {
    return json({ code: -1, message: 'apiname or path is required', data: null }, 400);
  }

  // path 优先；否则按 apiname 映射到上游子路径
  const upstreamPath = pathOverride || API_PATH_MAP[apiname as string];
  if (!upstreamPath) {
    return json({ code: -1, message: 'unknown apiname: ' + apiname + '（未配置上游路径映射）', data: null }, 400);
  }

  const upstreamUrl = NUMCAT_BASE_URL + '/' + upstreamPath.replace(/^\//, '');
  // 上游请求体：apikey 来自 env（不暴露给前端），其余透传前端传入
  const upstreamBody = {
    apiname: apiname,
    apikey: NUMCAT_API_KEY,
    params: params,
    fields: fields,
  };

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ code: -1, message: 'numcat upstream fetch failed: ' + msg, data: null }, 502);
  }

  let upstreamJson: any;
  try {
    upstreamJson = await upstreamResp.json();
  } catch {
    const text = await upstreamResp.text().catch(() => '');
    return json({ code: -1, message: 'numcat upstream returned non-JSON: ' + text.slice(0, 200), data: null }, 502);
  }

  const code = (typeof upstreamJson?.code === 'number') ? upstreamJson.code : (upstreamResp.ok ? 200 : upstreamResp.status);
  // 上游业务错误（code !== 200）：透传 code/message，前端会 throw
  if (code !== 200) {
    return json({ code, message: upstreamJson?.message || 'numcat error', data: null }, 200);
  }

  // 前端期望 response.data 上携带 fields / items，因此把上游整体作为 data 透传；
  // 若上游本身已包在 data 字段，则优先用 data（兼容两种响应结构）。
  const payload = (upstreamJson && typeof upstreamJson === 'object' && 'data' in upstreamJson && upstreamJson.data != null)
    ? upstreamJson.data
    : upstreamJson;

  return json({ code: 200, message: upstreamJson?.message || 'ok', data: payload });
});
