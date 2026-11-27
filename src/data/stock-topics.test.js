import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { state } from '../logic/app-state.js';
import { invalidateTopicCache, buildTopicCache, lookupTopicsByName, rebuildTopicCacheForHotData, isHotDerivedTopicsReady } from './stock-topics.js';

// ===== 共享题材库的【权威性】回归测试（2026-09-19 事故）=====
//
// 事故：用户在早盘竞价看板把「桂林旅游」的「人工智能」删掉，共享题材库也写对了
//      （stock_topics.桂林旅游 = 「旅游,大消费」），但涨跌停看板仍显示「人工智能」。
// 根因：`scanDataSourceForTopics` 在「共享库铺底」之后，又把每一条历史 note 括号里的题材
//      **只增不减**地并进 `_topicCache` —— 09-09 那条历史 note 里的「人工智能」被反复加回来。
// 修复：共享库是跨看板题材的唯一权威来源；历史 note 只对「库里还没有的股票」兜底。
//
// 本测试锁定 6 件事，任何一条被打回都说明闸门被改坏了。

const asText = (name) => {
    const s = lookupTopicsByName(name);
    return s ? [...s].join(',') : '';
};

const _saved = {};

beforeEach(() => {
    _saved.cloud = state._cloudTopicsCache;
    _saved.auction = state._auctionMemCache;
    _saved.hot = state._hotAuctionData;
    _saved.built = state._topicCacheBuilt;
    _saved.hotReady = state._hotDerivedTopicsReady;
});

afterEach(() => {
    state._cloudTopicsCache = _saved.cloud;
    state._auctionMemCache = _saved.auction;
    state._hotAuctionData = _saved.hot;
    state._hotDerivedTopicsReady = _saved.hotReady;
    invalidateTopicCache();
    if (_saved.built) buildTopicCache();
});

/** 铺一份「云端实测数据形态」的输入，并重建缓存 */
function setup() {
    state._cloudTopicsCache = {
        '桂林旅游': new Set(['旅游', '大消费']),      // 用户编辑后的权威结果
        '中岩大地': new Set(['题材20', '题材21']),    // 只有占位编号 → 不算权威
        '有研新材': new Set(['存储', '靶材']),        // 权威 → 历史 note 的附加题材必须被挡掉
        '万  科Ａ': new Set(['房地产', '并购重组'])   // 非规范写法 → 验证归一化别名兜底
    };
    state._hotAuctionData = {};
    state._auctionMemCache = {
        '2026-09-09': [{ stock: '桂林旅游', note: '+9.99%(旅游，人工智能)', topics: '旅游,大消费' }],
        '2026-09-14': [{ stock: '桂林旅游', note: '10.03%(旅游)', topics: '旅游,大消费' }],
        '2026-09-15': [{ stock: '桂林旅游', note: '-10.04%(大消费,旅游)', topics: '大消费,旅游' }],
        '2026-07-17': [{ stock: '中岩大地', note: '10.01%(并购重组)', topics: '' }],
        '2026-08-12': [{ stock: '有研新材', note: '+0.57%(芯片)', topics: '' }],
        '2026-07-15': [{ stock: '某某股份', note: '9.99%(煤炭,并购重组)', topics: '' }]
    };
    invalidateTopicCache();
    buildTopicCache();
}

describe('共享题材库权威性（历史 note 不得让已删题材复活）', () => {
    it('① 用户删掉的题材不再被历史 note 加回来', () => {
        setup();
        const t = asText('桂林旅游');
        expect(t).not.toContain('人工智能');
        expect(t).toContain('旅游');
        expect(t).toContain('大消费');
    });

    it('② 缓存重建（Realtime / 刷新）后依然不复活', () => {
        setup();
        invalidateTopicCache();
        buildTopicCache();
        invalidateTopicCache();
        buildTopicCache();
        expect(asText('桂林旅游')).not.toContain('人工智能');
    });

    it('③ 库外股票仍由历史 note 兜底（行为不变）', () => {
        setup();
        expect(asText('某某股份')).toBe('煤炭,并购重组');
    });

    it('④ 库里只有占位题材时不算权威，仍走 note 兜底（不误伤）', () => {
        setup();
        const t = asText('中岩大地');
        expect(t).toContain('题材20');
        expect(t).toContain('并购重组');
    });

    it('⑤ 权威库的题材集合就是最终结果（note 的附加题材被挡掉）', () => {
        setup();
        expect(asText('有研新材')).toBe('存储,靶材');
    });

    it('⑥ 归一化别名兜底仍然生效', () => {
        setup();
        expect(asText('万科A')).toBe('房地产,并购重组');
    });

    it('⑦ 题材库【未拉取】（null）时不做任何拦截，全部走 note 兜底（§10 读取失败≠空）', () => {
        state._cloudTopicsCache = null;
        state._hotAuctionData = {};
        state._auctionMemCache = {
            '2026-09-09': [{ stock: '桂林旅游', note: '+9.99%(旅游，人工智能)', topics: '' }]
        };
        invalidateTopicCache();
        buildTopicCache();
        expect(asText('桂林旅游')).toBe('旅游,人工智能');
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// ★★ [HOT-TOPIC-SYNC 2026-11-25] hot 到货后题材缓存统一重建（整类根因，非单只票）
//
//   原尚股份题材只在 hot_stocks.note（07-31 `摘帽+汽车物流+跨境电商+氢能源`），
//   stock_topics 库 / 当日 auction_watchlist 都没有 ⇒ 只有 buildTopicCache 扫 hot 才拿得到。
//   题材缓存幂等、常早于 hot 数据首次建成 ⇒ 不 invalidate+build 就永远缺（显示 '-'），
//   直到某个无关 invalidate 偶然重建才变「跨境电商」（大消费 3→4 只、九阳股份进出）。
// ══════════════════════════════════════════════════════════════════════════════
describe('hot 到货后重建题材缓存（HOT-TOPIC-SYNC）', () => {
    /** 复现事故形态：hot 数据到货【前】已幂等建好缓存，此时扫不到 hot note 题材 */
    function setupHotLateArrival() {
        state._cloudTopicsCache = {};                       // 库里没有原尚股份
        state._auctionMemCache = {
            '2026-11-25': [{ stock: '杭州解百', note: '+9.9%(大消费)', topics: '' }]
        };
        state._hotAuctionData = {};                          // 到货前：hot 空
        state._hotDerivedTopicsReady = false;
        invalidateTopicCache();
        buildTopicCache();                                   // 早建缓存（幂等锁死）
    }

    it('① hot 到货前：只在 hot note 里的题材查不到（显示 - 的成因）', () => {
        setupHotLateArrival();
        expect(asText('原尚股份')).toBe('');
        expect(isHotDerivedTopicsReady()).toBe(false);
    });

    it('② hot 到货 + rebuild ⇒ 题材进缓存 + 就绪标志置位', () => {
        setupHotLateArrival();
        // 模拟 hot 数据到货
        state._hotAuctionData = {
            '2026-07-31': [{ stock: '原尚股份', note: '+1.86%(摘帽+汽车物流+跨境电商+氢能源)', topics: '' }]
        };
        rebuildTopicCacheForHotData();
        const t = asText('原尚股份');
        expect(t).toContain('跨境电商');
        expect(t).toContain('汽车物流');
        expect(isHotDerivedTopicsReady()).toBe(true);
    });

    it('③ 单独 buildTopicCache（不 invalidate）无法让 hot 题材进来（幂等反例）', () => {
        setupHotLateArrival();
        state._hotAuctionData = {
            '2026-07-31': [{ stock: '原尚股份', note: '+1.86%(跨境电商)', topics: '' }]
        };
        buildTopicCache();                                   // 幂等直接返回旧缓存
        expect(asText('原尚股份')).toBe('');
        // 必须先 invalidate 再 build（rebuildTopicCacheForHotData 内部正是如此）
        rebuildTopicCacheForHotData();
        expect(asText('原尚股份')).toContain('跨境电商');
    });

    it('④ hot 读取失败（空数据）也置就绪标志（§10 读过就算落地，⛌ 不永久挂死买点）', () => {
        setupHotLateArrival();
        state._hotAuctionData = {};                          // 读失败 / 空库
        rebuildTopicCacheForHotData();
        expect(isHotDerivedTopicsReady()).toBe(true);
    });

    it('⑤ 三条到货路径（刷新 / Realtime / 手动登录）都接了统一重建入口（锁调用形态，⛔ 不锁注释）', () => {
        // 静态锁的是【调用/导入形态】而非裸标识符或注释（esbuild 会删注释，11-25 踩过）。
        const bootstrap = readFileSync('src/composables/useAppBootstrap.js', 'utf8');
        const realtime = readFileSync('src/data/hot-stocks-realtime.js', 'utf8');
        const login = readFileSync('src/components/LoginOverlay.vue', 'utf8');
        const settle = readFileSync('src/logic/topicvolratio/buy-settle.js', 'utf8');
        const gate = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');

        expect(bootstrap).toContain('rebuildTopicCacheForHotData');
        expect(bootstrap).toContain('loadHotStocksFromCloud()');
        expect(realtime).toContain('rebuildTopicCacheForHotData()');
        expect(login).toContain('rebuildTopicCacheForHotData()');
        // 门控第⑱项 + 传参闭环
        expect(settle).toContain('o.hotDerivedTopicsReady === false');
        expect(gate).toContain('hotDerivedTopicsReady: isHotDerivedTopicsReady()');
    });
});
