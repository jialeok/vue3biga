// buyable-count.test.js — [BUYABLE-COUNT 2026-11-19 用户口径] 「选股 N 只」数的是【今天能下单的只数】
//
// 用户原话：「可以改下计数那里」。
//
// 现场（11-17 真机截图）：第三十五条已经选出九阳股份（灰块之外、今天唯一能买的那一只），
//   灰块里【广百股份 / 日出东方】挂着「分歧日不买」却被数进「选股 N 只」
//   ⇒ 顶部写「选股 3 只」，实际只能买 1 只。
//
// 这条链只有一处判据（`tvrb-utils.js#_isBuyablePick`）和一处清单（`tvrb-constants.js#NO_BUY_ACTION_TAGS`），
// 但「新加一枚不买标签却忘了登记」这种漏，屏幕上看不出来（只是数字虚高）—— 所以用静态锁钉死：
//   ① 七枚已知「不买」标签必须都在清单里；
//   ② 源码里任何 `buyActionTag = XXX_NO_BUY_TAG / XXX_BAN_TAG` 必须已被清单覆盖（新增标签没登记 ⇒ 直接红）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  NO_BUY_ACTION_TAGS,
  EBB_NO_BUY_TAG,
  CASH_NO_BUY_TAG,
  TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG,
  SECOND_TOPIC_VOLWEAK_NO_BUY_TAG,
  DIVERGE_NO_BUY_TAG,
  ABNORMAL_NO_BUY_TAG,
  ABNORMAL_TOPIC_BAN_TAG,
  TOP30_HUDDLE_TAG,
  CATCH_UP_TAG,
  WEAK_HUDDLE_TAG,
  AUCTION_YIZI_WAIT_TAG
} from './tvrb-constants.js';
import { _isBuyablePick } from './tvrb-utils.js';

const ROOT = path.resolve(__dirname, '../../..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('[BUYABLE-COUNT] 「不买」标签总表', () => {
  it('七枚已知「不买 / 不开新仓」标签全部登记', () => {
    expect(NO_BUY_ACTION_TAGS).toEqual([
      EBB_NO_BUY_TAG,
      CASH_NO_BUY_TAG,
      TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG,
      SECOND_TOPIC_VOLWEAK_NO_BUY_TAG,
      DIVERGE_NO_BUY_TAG,
      ABNORMAL_NO_BUY_TAG,
      ABNORMAL_TOPIC_BAN_TAG
    ]);
    expect(new Set(NO_BUY_ACTION_TAGS).size).toBe(NO_BUY_ACTION_TAGS.length);   // 不许重复
  });

  it('可买的买点标签【不在】表内（否则会把要买的票数丢）', () => {
    [TOP30_HUDDLE_TAG, CATCH_UP_TAG, WEAK_HUDDLE_TAG, AUCTION_YIZI_WAIT_TAG].forEach(function(t) {
      expect(NO_BUY_ACTION_TAGS).not.toContain(t);
    });
  });
});

describe('[BUYABLE-COUNT] _isBuyablePick 判据', () => {
  it('普通买点行（含竞价一字「等下杀买」）⇒ 能下单', () => {
    expect(_isBuyablePick({ name: '九阳股份', buyActionTag: TOP30_HUDDLE_TAG })).toBe(true);
    expect(_isBuyablePick({ name: '广百股份', buyActionTag: AUCTION_YIZI_WAIT_TAG })).toBe(true);
    expect(_isBuyablePick({ name: '日出东方', buyActionTag: '竞价买' })).toBe(true);
  });

  it('无标签 ⇒ 按能下单处理（§10：标签缺失是正常买点行的既定形态）', () => {
    expect(_isBuyablePick({ name: '九阳股份' })).toBe(true);
    expect(_isBuyablePick({ name: '九阳股份', buyActionTag: '' })).toBe(true);
    expect(_isBuyablePick({ name: '九阳股份', buyActionTag: null })).toBe(true);
  });

  it('七枚「不买」标签逐一判定 ⇒ 一律不能下单', () => {
    NO_BUY_ACTION_TAGS.forEach(function(tag) {
      expect(_isBuyablePick({ name: '广百股份', buyActionTag: tag })).toBe(false);
    });
  });

  it('第三十四条延伸的标记位（abnormalTopicBlocked）⇒ 不能下单', () => {
    expect(_isBuyablePick({ name: '日出东方', buyActionTag: ABNORMAL_TOPIC_BAN_TAG, abnormalTopicBlocked: true })).toBe(false);
    expect(_isBuyablePick({ name: '日出东方', abnormalTopicBlocked: true })).toBe(false);
  });

  it('没有名字 ⇒ 不是一行，不计入', () => {
    expect(_isBuyablePick(null)).toBe(false);
    expect(_isBuyablePick({})).toBe(false);
    expect(_isBuyablePick({ name: '   ' })).toBe(false);
  });
});

describe('[BUYABLE-COUNT] 接线锁：计数只能走这一处判据', () => {
  it('tvrb-plan.js 的 _countUnique 用 _isBuyablePick（⛔ 不许再抄一遍 if）', () => {
    const plan = read('src/logic/topicvolratio/tvrb-plan.js');
    const i = plan.indexOf('const _countUnique = function(arr) {');
    expect(i).toBeGreaterThan(-1);
    const seg = plan.slice(i, plan.indexOf('};', i));
    expect(seg).toContain('_isBuyablePick(p)');
    expect(seg).toContain('_pickSeen.add');
  });

  it('源码里所有「不买 / 禁入」标签赋值都已被 NO_BUY_ACTION_TAGS 覆盖（新增标签忘登记 ⇒ 红）', () => {
    const files = [
      'src/logic/topicvolratio/tvrb-blocks.js',
      'src/logic/topicvolratio/abnormal-overlay.js',
      'src/logic/topicvolratio/tvrb-plan.js'
    ];
    const consts = read('src/logic/topicvolratio/tvrb-constants.js');
    // 常量名 → 实际字符串值（从常量文件里抓 `export const X = '...'`）
    const nameToValue = {};
    (consts.match(/export const ([A-Z0-9_]+) = '([^']*)';/g) || []).forEach(function(line) {
      const m = /export const ([A-Z0-9_]+) = '([^']*)';/.exec(line);
      if (m) nameToValue[m[1]] = m[2];
    });
    const missing = [];
    files.forEach(function(f) {
      const src = read(f);
      (src.match(/buyActionTag = ([A-Z0-9_]+);/g) || []).forEach(function(hit) {
        const name = /buyActionTag = ([A-Z0-9_]+);/.exec(hit)[1];
        if (!/NO_BUY|_BAN_TAG$/.test(name)) return;          // 只盯「不买 / 禁入」这一类
        const val = nameToValue[name];
        if (val === undefined) return;                        // 不是本文件的字符串常量（如函数参数），跳过
        if (NO_BUY_ACTION_TAGS.indexOf(val) < 0) missing.push(f + ' → ' + name + '（' + val + '）');
      });
    });
    expect(missing).toEqual([]);
  });
});
