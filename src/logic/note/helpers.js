export function parseNoteToFields(note) {
    if (!note && note !== 0) return { changePct: '', topics: '' };
    // [FIX 2026-09-18] 强制转字符串：本函数是多个看板共用的入口，历史上只被喂过字符串，
    // 但只要有一个调用方把「涨幅」当成 number 传进来（竞价一字的十日涨幅就踩过），
    // 下面第一行 `note.match(…)` 就会抛 `t.match is not a function` ——
    // 报错信息完全看不出是「传了数字」，且会被上层 catch 成一个看板整体加载失败。
    // 在这里收口成字符串，等价于「按文本处理」，对所有既有字符串入参零行为变化。
    const text = String(note);
    var changePct = '';
    var pctMatch = text.match(/([+-]?\d+\.?\d*%)/);
    if (pctMatch) {
        changePct = pctMatch[1];
    } else if (text.includes('涨停')) {
        changePct = '涨停';
    } else if (text.includes('跌停')) {
        changePct = '跌停';
    } else if (text.includes('停牌')) {
        changePct = '停牌';
    }
    var bracketMatches = text.match(/[(（]([^)）]+)[)）]/g) || [];
    var topics = bracketMatches.map(function(m) {
        return m.replace(/[()（）]/g, '');
    }).join(',').replace(/[，、;；]/g, ',');
    return { changePct: changePct, topics: topics };
}

export function cleanTopicsForDisplay(topics) {
    if (!topics && topics !== 0) return '';
    return String(topics).split(/[+，,，、;；]/).map(function(t) { return t.trim(); }).filter(function(t) {
        if (!t) return false;
        if (/^题材\d+$/.test(t)) return false;
        if (/^\d+$/.test(t)) return false;
        if (t.length < 2) return false;
        return true;
    }).join('，');
}

export function buildNoteFromFields(changePct, topics) {
    // [FIX 2026-09-18] 必须保证返回值是【字符串】：下面 `note += …` 只在 cleanTopics 非空时执行，
    // 所以当 changePct 是 number 且 topics 为空时，旧实现会原样返回那个 number，
    // 让 getDisplayNote → extractTopics 一路把数字当字符串用而崩溃。这里收口。
    var note = String(changePct === null || changePct === undefined ? '' : changePct);
    var cleanTopics = cleanTopicsForDisplay(topics);
    if (cleanTopics) {
        note += '(' + cleanTopics + ')';
    }
    return note;
}

export function getDisplayNote(item) {
    if (!item) return '';
    if (item.changePct || item.topics) {
        var topics = item.topics || '';
        if (!topics && item.note) {
            var parsed = parseNoteToFields(item.note);
            topics = parsed.topics;
        }
        return buildNoteFromFields(item.changePct, topics);
    }
    return item.note || '';
}

export function extractTopics(note) {
    if (!note && note !== 0) return [];
    const matches = String(note).match(/[(（]([^)）]+)[)）]/g) || [];
    let topics = [];
    matches.forEach(m => {
        const content = m.replace(/[()（）]/g, '');
        const splitTopics = content.split(/[+，、,;；]/).map(t => t.trim()).filter(t => t);
        topics = topics.concat(splitTopics);
    });
    topics = topics.filter(isValidTopic);
    var _seen = new Set();
    var _deduped = [];
    topics.forEach(function(t) {
        var key = t.replace(/\s+/g, '').toLowerCase();
        if (!_seen.has(key)) { _seen.add(key); _deduped.push(t); }
    });
    return _deduped;
}

/**
 * 判断单条题材文本是否为「有效的真实题材」，供展示/分组清洗统一使用。
 * 过滤规则（与历史清洗口径一致）：
 *   - 空 / 纯空白
 *   - 开盘啦 API 编号占位符「题材\d+」（如 题材33 / 题材34 / 题材19，非真实分类）
 *   - 纯数字
 *   - 长度 < 2（单字无意义）
 *   - 占位词 '---' / '其它' / '其他'
 * 该函数是单条题材的权威清洗口径，extractTopics 与各兜底分支都应复用它，
 * 避免某条路径漏过滤导致「题材33」这类字样泄漏到界面。
 * @param {string} topic
 * @returns {boolean}
 */
export function isValidTopic(topic) {
    if (!topic || typeof topic !== 'string') return false;
    const t = topic.trim();
    if (!t) return false;
    if (/^题材\d+$/.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (t.length < 2) return false;
    if (t === '---' || t === '其它' || t === '其他') return false;
    return true;
}