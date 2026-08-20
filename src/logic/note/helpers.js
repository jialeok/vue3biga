export function parseNoteToFields(note) {
    if (!note) return { changePct: '', topics: '' };
    var changePct = '';
    var pctMatch = note.match(/([+-]?\d+\.?\d*%)/);
    if (pctMatch) {
        changePct = pctMatch[1];
    } else if (note.includes('涨停')) {
        changePct = '涨停';
    } else if (note.includes('跌停')) {
        changePct = '跌停';
    } else if (note.includes('停牌')) {
        changePct = '停牌';
    }
    var bracketMatches = note.match(/[(（]([^)）]+)[)）]/g) || [];
    var topics = bracketMatches.map(function(m) {
        return m.replace(/[()（）]/g, '');
    }).join(',').replace(/[，、;；]/g, ',');
    return { changePct: changePct, topics: topics };
}

export function cleanTopicsForDisplay(topics) {
    if (!topics) return '';
    return topics.split(/[+，,，、;；]/).map(function(t) { return t.trim(); }).filter(function(t) {
        if (!t) return false;
        if (/^题材\d+$/.test(t)) return false;
        if (/^\d+$/.test(t)) return false;
        if (t.length < 2) return false;
        return true;
    }).join('，');
}

export function buildNoteFromFields(changePct, topics) {
    var note = changePct || '';
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
    if (!note) return [];
    const matches = note.match(/[(（]([^)）]+)[)）]/g) || [];
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