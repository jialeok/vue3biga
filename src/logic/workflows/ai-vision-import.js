// ============================================================
//  AI识图模块 (从 index.html 抽离)
//  职责：AI识图导入的流程编排，调用 Supabase qwen-vision 函数 + 写入竞价数据
// ============================================================
import { replaceHotConceptFromPaste, importAuctionFromPaste, replaceConceptFromPaste, importHotFromPaste } from '../app-core-api.js';
import { _domSetText, _domSetValue, _domSetDisplay, _domSetColor, _domGet, _domQuery, _domValue, _domCreate, _domAddEventListener, _domAddEventListenerDoc } from '../ui-bridge.js';
const SUPABASE_FUNC_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/qwen-vision';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

let _aiVisionImages = []; // [{name, base64}]
let _aiVisionTarget = null; // 'auction' | 'hot'，标记 AI 识图来源弹窗

const AI_VISION_PROMPTS = [
  // 0 - 占比
  `你是股票数据表格整理专家。\n任务：提取图片中的股票数据，输出一个可直接复制粘贴进 Excel 的 Tab 分隔纯文本表格，禁止生成文件、禁止任何解释说明。\n表格规则：\n- 表头固定为：股票名称\t竞价量\t昨日成交量\n- 只保留"竞价量"和"昨日成交量"两列数据，其余字段全部丢弃\n- 重复股票名称只保留一条\n单位换算（数值统一换算为万，表头不标注单位）：\n- 无单位的原始数字 → 换算为万并四舍五入保留一位小数（如 46205 → 4.6）\n- 亿单位 → 换算为万（如 2.1亿 → 21000）\n- 已是万单位 → 直接填写数字\n输出格式示例：\n\`\`\`\n股票名称\t竞价量\t昨日成交量\n示例股票\t4.6\t89.3\n\`\`\`\n用代码块包裹输出内容，方便一键复制，不加任何额外说明、不生成文件。`,

  // 1 - 涨幅
  `你是股票数据表格整理专家。\n任务：提取图片中的股票数据，输出一个Tab分隔纯文本表格，禁止生成文件、禁止任何解释说明。\n表格规则：\n- 表头固定为：股票名称\t涨幅\n- 只保留这两列数据，其余字段全部丢弃\n- 重复股票名称只保留一条\n- 涨幅数值保留两位小数，带%符号（如+3.25%或-1.08%）\n直接输出Tab分隔纯文本，不加任何说明、不生成文件、不加代码块包裹。`,

  // 2 - 涨幅+概念
  `你是股票数据表格整理专家。\n任务：提取图片中的股票数据，输出一个Tab分隔纯文本表格，禁止生成文件、禁止任何解释说明。\n表格规则：\n- 表头固定为：股票名称\t涨幅\t所属概念\n- 只保留这三列数据，其余字段全部丢弃\n- 重复股票名称只保留一条\n- 涨幅数值保留两位小数，带%符号（如+3.25%或-1.08%）\n- 所属概念：每只股票只取前两个概念，放在同一个格子里，用顿号分隔（如 人工智能、半导体）\n直接输出Tab分隔纯文本，不加任何说明、不生成文件、不加代码块包裹。`,

  // 3 - 仅概念
  `你是股票数据表格整理专家。\n任务：提取图片中的股票数据，输出一个Tab分隔纯文本表格，禁止生成文件、禁止任何解释说明。\n表格规则：\n- 表头固定为：股票名称\t所属概念\n- 只保留这两列数据，其余字段全部丢弃\n- 重复股票名称只保留一条\n- 所属概念：将该股票所有概念全部放在同一格子里，用顿号分隔，相同概念去重\n直接输出Tab分隔纯文本，不加任何说明、不生成文件、不加代码块包裹。`
];

export function openAiVisionModal() {
  _aiVisionTarget = 'auction';
  _aiVisionImages = [];
  _domSetText('aiVisionThumbs', '');
  _domSetValue('aiVisionResult', '');
  _domSetText('aiVisionStatus', '');
  _domSetDisplay('aiVisionModal', 'block');
}

export function closeAiVisionModal() {
  _domSetDisplay('aiVisionModal', 'none');
}

// 关闭：点击遮罩 + 粘贴截图支持
queueMicrotask(function() {
  _domAddEventListener('aiVisionModal', 'click', function(e) {
    if (e.target === _domGet('aiVisionModal')) closeAiVisionModal();
  });
  _domAddEventListenerDoc('paste', function(e) {
    const modal = _domGet('aiVisionModal');
    if (!modal || modal.style.display === 'none') return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) aiVisionAddFile(file);
      }
    }
  });
});

export function aiVisionHandleFiles(files) {
  for (const file of files) aiVisionAddFile(file);
}

export function aiVisionAddFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    const base64 = dataUrl.split(',')[1];
    const id = Date.now() + Math.random();
    _aiVisionImages.push({ id, base64, name: file.name || 'paste' });
    // 缩略图
    const thumbBox = _domCreate('div');
    thumbBox.style.cssText = 'position:relative;width:60px;height:60px;flex-shrink:0;';
    const img = _domCreate('img');
    img.src = dataUrl;
    img.style.cssText = 'width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;';
    const del = _domCreate('button');
    del.textContent = '×';
    del.style.cssText = 'position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;border:none;font-size:12px;line-height:1;cursor:pointer;padding:0;';
    del.onclick = function() {
      _aiVisionImages = _aiVisionImages.filter(x => x.id !== id);
      thumbBox.remove();
    };
    thumbBox.appendChild(img);
    thumbBox.appendChild(del);
    _domGet('aiVisionThumbs').appendChild(thumbBox);
  };
  reader.readAsDataURL(file);
}

export async function aiVisionRun() {
  if (_aiVisionImages.length === 0) {
    _domSetText('aiVisionStatus', '⚠️ 请先上传图片');
    _domSetColor('aiVisionStatus', '#dc2626');
    return;
  }
  const modeVal = parseInt(_domQuery('input[name="aiVisionMode"]:checked').value);
  const prompt = AI_VISION_PROMPTS[modeVal];

  const btn = _domGet('aiVisionRunBtn');
  btn.disabled = true;
  btn.textContent = '识别中…';

  const statusEl = _domGet('aiVisionStatus');

  // 逐张识别，合并去重
  const allLines = new Map(); // stock → line string
  let errorCount = 0;

  for (let i = 0; i < _aiVisionImages.length; i++) {
    statusEl.textContent = `识别中… ${i + 1}/${_aiVisionImages.length}`;
    statusEl.style.color = '#6b7280';
    try {
      const resp = await fetch(SUPABASE_FUNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON}`
        },
        body: JSON.stringify({
          images: [_aiVisionImages[i].base64],
          prompt
        })
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      let text = data.result || '';
      // 去掉代码块包裹（占比模式会有```）
      text = text.replace(/```[^\n]*\n?/g, '').trim();

      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const cells = line.split('\t');
        if (!cells[0]) continue;
        const stockName = cells[0].trim();
        // 跳过表头行
        if (['股票名称', '名称'].includes(stockName)) continue;
        if (!allLines.has(stockName)) {
          allLines.set(stockName, line);
        }
      }
    } catch (err) {
      errorCount++;
      console.error('图片识别失败', err);
    }
  }

  btn.disabled = false;
  btn.textContent = '🔍 开始识别';

  if (allLines.size === 0) {
    statusEl.textContent = errorCount > 0 ? `❌ 识别失败，请检查API Key或网络` : '⚠️ 未提取到数据';
    statusEl.style.color = '#dc2626';
    return;
  }

  // 组装输出（补表头）
  const headerMap = ['股票名称\t竞价量\t昨日成交量', '股票名称\t涨幅', '股票名称\t涨幅\t所属概念', '股票名称\t所属概念'];
  const output = [headerMap[modeVal], ...allLines.values()].join('\n');
  _domSetValue('aiVisionResult', output);
  statusEl.textContent = `✅ 识别完成，共 ${allLines.size} 条${errorCount > 0 ? `（${errorCount}张识别失败）` : ''}`;
  statusEl.style.color = '#059669';
}

export function aiVisionWrite() {
  const result = _domValue('aiVisionResult').trim();
  if (!result) {
    _domSetText('aiVisionStatus', '⚠️ 识别结果为空');
    _domSetColor('aiVisionStatus', '#dc2626');
    return;
  }
  // 根据来源弹窗决定写入哪个 textarea、调用哪组函数
  const isHot = _aiVisionTarget === 'hot';
  const textareaId = isHot ? 'hotPasteInput' : 'auctionPasteInput';
  const textarea = _domGet(textareaId);
  if (!textarea) { throw new Error('找不到输入框'); }
  textarea.value = result;

  // 根据写入方式调用对应函数
  const action = _domQuery('input[name="aiVisionAction"]:checked').value;
  if (action === 'import') {
    if (isHot) importHotFromPaste(); else importAuctionFromPaste();
  } else {
    if (isHot) replaceHotConceptFromPaste(); else replaceConceptFromPaste();
  }
  _aiVisionTarget = null; // 用完重置
  closeAiVisionModal();
}