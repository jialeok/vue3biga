// temp-core-topics.test.js — 锁定 2026-11-26 事故：强制重读必须真的发请求
//
// 事故：启动那次 ensureTempCoreTopics 失败 ⇒ `_loaded=true` + `_rows=[]`。
//   旧 refreshTempCoreTopics 只把 _cooldownUntil 清 0，**没清 _loaded**
//   ⇒ ensure 第一行 `_loaded && now >= _cooldownUntil` 直接早退返回空数组
//   ⇒ 弹窗永远显示「没有临时题材」，且不抛错 ⇒ 用户连红字都看不到。
//   本用例：第一次读失败后，refresh 必须重新发请求并把行读回来。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ impl: null }));

vi.mock('./supabase-client.js', () => ({ getSupabase: () => ({}) }));
vi.mock('./paged-fetch.js', () => ({ fetchAllPages: () => state.impl() }));

import {
  ensureTempCoreTopics,
  refreshTempCoreTopics,
  getTempCoreTopics,
  clearTempCoreTopicsCache
} from './temp-core-topics.js';

const ROW = {
  id: 4,
  name: '羊字辈',
  synonyms: '["羊字辈"]',
  start_date: '2026-11-18',
  disabled_from: null,
  updated_at: ''
};

describe('临时核心词 · 强制重读（2026-11-26 事故锁）', function () {
  beforeEach(function () {
    clearTempCoreTopicsCache();
  });

  it('启动读失败后 ⇒ refresh 必须重新发请求并拿到数据（旧实现永久返回空）', async function () {
    state.impl = function () { return Promise.reject(new Error('network down')); };
    await expect(ensureTempCoreTopics()).rejects.toThrow();
    expect(getTempCoreTopics()).toHaveLength(0);

    state.impl = function () { return Promise.resolve([ROW]); };
    const rows = await refreshTempCoreTopics();
    expect(rows).toHaveLength(1);
    expect(getTempCoreTopics()[0].name).toBe('羊字辈');
  });
});
