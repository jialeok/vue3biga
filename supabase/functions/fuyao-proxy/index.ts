// ===========================================================================
// fuyao-proxy — Supabase Edge Function (Deno)
// 代理「同花顺 fuyao」行情接口，隐藏 API key（仅从 Deno.env 读取，绝不明文硬编码）。
//
// 前端调用契约（src/data/api/fuyao-proxy.js）：
//   GET /functions/v1/fuyao-proxy?path=<api path>&<其它业务参数>
//   成功：透传上游 JSON { code: 0, message, data }
//   失败：{ code: <非零>, message, data: null }  ← 前端据此 throw
//
// 上游（同花顺 fuyao）：
//   GET https://fuyao.aicubes.cn<path>?<params>
//   请求头：X-api-key: <FUYAO_API_KEY>
//   响应：  { code: 0, message, data }（成功码为 0）
//
// 本函数的请求/响应形状与 bidding-a/index.ts 内的 fuyaoGet() 完全一致（fuyao.aicubes.cn + X-api-key）。
//
// 部署（二选一）：
//   A. Dashboard：Functions → 新建 fuyao-proxy → 粘贴本文件全部内容。
//   B. CLI：supabase functions deploy fuyao-proxy  （本文件位置即 supabase/functions/fuyao-proxy/index.ts）
// 部署后务必在 Secrets 里设置 FUYAO_API_KEY（FUYAO_BASE_URL 可选，默认 https://fuyao.aicubes.cn）。
// 函数设置：按需要决定是否关闭 Verify JWT（前端用 anon key 调用）。
// ===========================================================================

const FUYAO_BASE_URL = (Deno.env.get('FUYAO_BASE_URL') || 'https://fuyao.aicubes.cn').replace(/\/$/, '');
const FUYAO_API_KEY = Deno.env.get('FUYAO_API_KEY') || '';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/health') {
    return json({ ok: true, service: 'fuyao-proxy' });
  }

  if (req.method !== 'GET') {
    return json({ code: -1, message: 'method not allowed', data: null }, 405);
  }

  if (!FUYAO_API_KEY) {
    return json({ code: -1, message: 'FUYAO_API_KEY 未配置（请在 Supabase Secrets 设置）', data: null }, 500);
  }

  const path = url.searchParams.get('path');
  if (!path) {
    return json({ code: -1, message: 'path param required', data: null }, 400);
  }

  // 复制除 path 外的所有 query 参数作为上游业务参数（与前端 fuyaoApiGet 写入的参数一致）
  const upstreamUrl = new URL(FUYAO_BASE_URL + '/' + path.replace(/^\//, ''));
  url.searchParams.forEach((v, k) => {
    if (k !== 'path') upstreamUrl.searchParams.set(k, v);
  });

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl.toString(), {
      headers: { 'X-api-key': FUYAO_API_KEY },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ code: -1, message: 'fuyao upstream fetch failed: ' + msg, data: null }, 502);
  }

  let upstreamJson: any;
  try {
    upstreamJson = await upstreamResp.json();
  } catch {
    const text = await upstreamResp.text().catch(() => '');
    return json({ code: -1, message: 'fuyao upstream returned non-JSON: ' + text.slice(0, 200), data: null }, 502);
  }

  const code = (typeof upstreamJson?.code === 'number') ? upstreamJson.code : (upstreamResp.ok ? 0 : upstreamResp.status);
  // 上游业务错误（code !== 0）：透传，前端会 throw；成功则原样返回上游 JSON（含 code:0/data/message）
  if (code !== 0) {
    return json({ code, message: upstreamJson?.message || 'fuyao error', data: null }, 200);
  }

  return json(upstreamJson);
});
