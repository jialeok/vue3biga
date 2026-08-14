/* 真实浏览器测试：验证早盘竞价观察组(蚂蚁线上)数量 == 前一天竞昨高光数
 * 用法：node obs-browser-test.cjs
 * 需要：playwright（managed workspace） + 已构建的 dist（BUILD_DIR）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const playwright = require('C:/Users/jialeok/.workbuddy/binaries/node/workspace/node_modules/playwright');

const BUILD_DIR = 'C:/c/tmp/vue3biga-build-1786693889';
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
    if (!container) return { obs: 0, reg: 0, total: 0, jingYest: null, obsNames: [], jingYestNames: [] };
    let obs = 0, reg = 0, seenSep = false;
    const obsNames = [];
    for (const child of container.children) {
      if (child.classList && child.classList.contains('auction-obs-separator')) { seenSep = true; continue; }
      if (child.classList && child.classList.contains('auction-item')) {
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
    return { obs, reg, total: obs + reg, jingYest, obsNames, jingYestNames };
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
    await page.waitForSelector('.auction-item', { state: 'attached', timeout: 90000 });
    await page.waitForTimeout(2500); // 等渲染稳定

    const defaultDate = (await page.textContent('.date-text')).trim();
    report.defaultDate = defaultDate;

    // 目标：(源日期 -> 观察日期)
    const cases = [
      { src: '2026-08-11', obs: '2026-08-12', label: '8/11高光 -> 8/12观察组' },
      { src: '2026-08-14', obs: '2026-08-17', label: '8/14高光 -> 8/17观察组' },
    ];

    for (const c of cases) {
      // 读源日期竞昨数 + 高光名单
      const [sy, sm, sd] = c.src.split('-').map(Number);
      await selectDate(page, sy, sm, sd);
      await page.waitForTimeout(2000);
      const srcBoard = await readBoard(page);
      // 读观察日期观察组数 + 名单
      const [oy, om, od] = c.obs.split('-').map(Number);
      await selectDate(page, oy, om, od);
      await page.waitForTimeout(2000);
      const obsBoard = await readBoard(page);
      const srcSet = new Set(srcBoard.jingYestNames || []);
      const obsSet = new Set(obsBoard.obsNames || []);
      const missingInObs = [...srcSet].filter(n => !obsSet.has(n));
      const extraInObs = [...obsSet].filter(n => !srcSet.has(n));
      report[c.label] = {
        srcDate: c.src,
        srcJingYest: srcBoard.jingYest,
        srcJingYestNames: srcBoard.jingYestNames,
        obsDate: c.obs,
        obsCount: obsBoard.obs,
        obsNames: obsBoard.obsNames,
        regCount: obsBoard.reg,
        match: srcBoard.jingYest !== null && srcBoard.jingYest === obsBoard.obs,
        missingInObs,
        extraInObs,
      };
    }
  } catch (e) {
    report.error = e.message;
  }

  report.logs = logs.slice(-40);
  console.log('=== OBS BROWSER TEST REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  server.close();
  // 退出码：有错误或不匹配则非0
  const allMatch = !report.error && Object.values(report).filter(v => v && v.match !== undefined).every(v => v.match);
  process.exit(allMatch ? 0 : 1);
})();
