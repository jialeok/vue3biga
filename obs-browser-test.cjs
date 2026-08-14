/* 真实浏览器测试：验证早盘竞价观察组(蚂蚁线上)数量 == 前一天竞昨高光数
 * 用法：node obs-browser-test.cjs
 * 需要：playwright（managed workspace） + 已构建的 dist（BUILD_DIR）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const playwright = require('C:/Users/jialeok/.workbuddy/binaries/node/workspace/node_modules/playwright');

const BUILD_DIR = 'C:/c/tmp/vue3biga-build-1786699768';
const PORT = 4178;
const PASSWORD = 'biga8450';

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.ico':'image/x-icon' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      urlPath = urlPath.replace(/^\/vue3biga/, ''); // 剥离 vite base 前缀
      if (urlPath === '' || urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(BUILD_DIR, urlPath);
      // SPA fallback
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        const idx = path.join(BUILD_DIR, 'index.html');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(fs.readFileSync(idx));
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function getTitle(page) {
  return (await page.textContent('.picker-month-title')).trim();
}
function parseTitle(t) {
  const m = t.match(/(\d+)年(\d+)月/);
  return m ? [parseInt(m[1],10), parseInt(m[2],10)] : [0,0];
}

async function selectDate(page, y, m, d) {
  // 打开日期选择器
  await page.click('.date-selector');
  await page.waitForSelector('.date-picker-calendar', { timeout: 10000 });
  let title = await getTitle(page);
  let guard = 0;
  while (guard < 300) {
    const [cy, cm] = parseTitle(title);
    if (cy === y && cm === m) break;
    if (cy < y || (cy === y && cm < m)) {
      await page.click('.date-picker-nav button:last-child'); // 下一月 ›
    } else {
      await page.click('.date-picker-nav button:first-child'); // 上一月 ‹
    }
    await page.waitForTimeout(60);
    title = await getTitle(page);
    guard++;
  }
  if (guard >= 300) throw new Error('无法导航到 ' + y + '年' + m + '月');
  // 点击目标日（精确匹配，排除 empty）
  const day = page.locator('.date-picker-calendar .calendar-day:not(.empty)', { hasText: new RegExp('^' + d + '$') }).first();
  await day.click();
  // 关闭弹窗
  await page.keyboard.press('Escape').catch(()=>{});
  await page.waitForTimeout(300);
}

async function readBoard(page) {
  return await page.evaluate(() => {
    const container = document.querySelector('.auction-scroll-container');
    if (!container) return { obs: 0, reg: 0, total: 0, jingYest: null, noData: 0, obsNames: [], jingYestNames: [] };
    let obs = 0, reg = 0, seenSep = false, noData = 0;
    const obsNames = [];
    for (const child of container.children) {
      if (child.classList && child.classList.contains('auction-obs-separator')) { seenSep = true; continue; }
      if (child.classList && child.classList.contains('auction-item')) {
        const volEl = child.querySelector('.auction-volume');
        const volTxt = volEl ? (volEl.textContent || '').trim() : '';
        if (volTxt === '' || volTxt === '—' || volTxt === '-') noData++;
        if (seenSep) reg++; else { obs++; const nm = child.querySelector('.auction-stock-name'); if (nm) obsNames.push(nm.textContent.trim()); }
      }
    }
    // 竞昨数（第0页）
    let jingYest = null;
    const spans = Array.from(document.querySelectorAll('span'));
    const el = spans.find(s => /竞昨数[：:]/.test(s.textContent));
    if (el) {
      const mm = el.textContent.match(/竞昨数[：:]\s*(\d+)/);
      if (mm) jingYest = parseInt(mm[1], 10);
    }
    // 竞昨高光股票名单（蓝色高光 .jing-yest-match）
    const jingYestNames = Array.from(document.querySelectorAll('.auction-item.jing-yest-match .auction-stock-name')).map(n => n.textContent.trim());
    return { obs, reg, total: obs + reg, jingYest, noData, obsNames, jingYestNames };
  });
}

(async () => {
  const server = await serve();
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push('[console] ' + m.text()));
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));

  const report = {};
  try {
    await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'domcontentloaded' });

    // 登录
    await page.waitForSelector('#pwdInput', { timeout: 15000 });
    await page.fill('#pwdInput', PASSWORD);
    await page.click('.login-btn');
    // 等待数据加载（竞价行出现，DOM 挂载即可，不强制可见性以避免长列表误判）
    try {
      await page.waitForSelector('.auction-item', { state: 'attached', timeout: 180000 });
    } catch (e) {
      const diag = await page.evaluate(() => {
        const c = document.querySelector('.auction-scroll-container');
        const all = document.querySelectorAll('.auction-item').length;
        const bodyTxt = (document.body.innerText || '').slice(0, 300);
        return { hasContainer: !!c, containerChildren: c ? c.children.length : -1, auctionItems: all, bodySnippet: bodyTxt };
      }).catch(() => null);
      report.error = 'waitForSelector .auction-item 超时: ' + e.message;
      report.diag = diag;
      throw e;
    }
    await page.waitForTimeout(2500); // 等渲染稳定

    const defaultDate = (await page.textContent('.date-text')).trim();
    report.defaultDate = defaultDate;

    // 目标：逐日期检查"影子记录"（无数据壳）是否已清除
    // 已抓取的历史/今天日期：必须 noData===0（无无数据壳）
    // 8/17 未抓取日：保留 16 只继承预览（允许全无数据）
    const dates = [
      { y: 2026, m: 8, d: 11, label: '8/11' },
      { y: 2026, m: 8, d: 12, label: '8/12' },
      { y: 2026, m: 8, d: 13, label: '8/13' },
      { y: 2026, m: 8, d: 14, label: '8/14' },
      { y: 2026, m: 8, d: 17, label: '8/17' },
    ];
    for (const dt of dates) {
      await selectDate(page, dt.y, dt.m, dt.d);
      await page.waitForTimeout(2200);
      const b = await readBoard(page);
      const isPreview = b.total > 0 && b.noData === b.total; // 全部无数据 = 纯继承预览日
      const ghostFree = isPreview ? true : (b.noData === 0);
      const entry = { obs: b.obs, reg: b.reg, total: b.total, noData: b.noData, jingYest: b.jingYest, isPreview, ghostFree };
      if (dt.label === '8/17') entry.obsPreviewOk = (b.obs === 16);
      report[dt.label] = entry;
    }
  } catch (e) {
    report.error = e.message;
  }

  report.logs = logs.slice(-40);
  console.log('=== OBS BROWSER TEST REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  server.close();
  // 退出码：有错误、任一日期仍有影子记录、或 8/17 预览异常则非0
  const dateEntries = Object.values(report).filter(v => v && v.ghostFree !== undefined);
  const allGhostFree = dateEntries.every(v => v.ghostFree);
  const previewOk = !report['8/17'] || report['8/17'].obsPreviewOk === true;
  const allMatch = !report.error && allGhostFree && previewOk;
  report.summary = { allGhostFree, previewOk, passed: allMatch };
  process.exit(allMatch ? 0 : 1);
})();
