import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { state } from '../logic/app-state.js';
import { invalidateTopicCache, buildTopicCache, lookupTopicsByName } from './stock-topics.js';

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
});

afterEach(() => {
    state._cloudTopicsCache = _saved.cloud;
    state._auctionMemCache = _saved.auction;
    state._hotAuctionData = _saved.hot;
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
