const defaultScoreSettings = {
    recentMulti: {
        die1: -5, die2: -3, die3: 5, die4: 6, die5: 7,
        zhang1: 5, zhang2: 3, zhang3: -5,
        kongcang: -5, chushou: 5,
        yangqun1: -6, yangqun2: -3, yangqun3: -4, yangqun4: -3,
        yangqun5: 6, yangqun6: 5, yangqun7: 4,
        yangqun8: -5, yangqun9: -6, yangqun10: -6, yangqun11: -7,
        jingjiaDie1: -5,
        dapanMore1: 5, dapanLess05: -8, dapanLess1: -10,
        zhang5More20: 10, zhang5More15: 8, zhang5More10: 2, zhang5Less10: -5,
        xingxian1: 3, xingxian2: 5, xingxian3: 7, xingxian4: 10,
        xingzeng1: 5, xingzeng2: 8, xingzeng3: 10,
        xingping1: 2, xingping2: 4, xingping3: 6,
        xingbao: 10, xingwangZeng: 15,
        qiangduMore50: 10, qiangdu40to50: 0, qiangdu30to40: -15, qiangduLess30: -20,
        qiangduMore50_banKuai: 10, qiangdu40to50_banKuai: 0, qiangdu30to40_banKuai: 10, qiangduLess30_banKuai: 0,
        qiangduMore50_ticai: 10, qiangdu40to50_ticai: 0, qiangdu30to40_ticai: 0, qiangduLess30_ticai: 10,
        fumianzhuti: -10
    },
    sectorEtf: {
        die1: 2, die2: 3, die3: 4, die4: 5, die5: 6,
        zhang1: 5, zhang2: 6, zhang3: -5,
        kongcang: -5, chushou: 5,
        yangqun1: -6, yangqun2: 5, yangqun3: 6, yangqun4: 0,
        yangqun5: 6, yangqun6: 5, yangqun7: -4,
        yangqun8: 5, yangqun9: -6, yangqun10: -6, yangqun11: -7,
        jingjiaDie1: -5,
        dapanMore1: 5, dapanLess05: -8, dapanLess1: -10,
        zhang5More20: 10, zhang5More15: 8, zhang5More10: 2, zhang5Less10: -5,
        xingxian1: 3, xingxian2: 5, xingxian3: 7, xingxian4: 10,
        xingzeng1: 5, xingzeng2: 8, xingzeng3: 10,
        xingping1: 2, xingping2: 4, xingping3: 6,
        xingbao: 10, xingwangZeng: 15,
        qiangduMore50: 10, qiangdu40to50: 0, qiangdu30to40: 10, qiangduLess30: 0,
        qiangduMore50_banKuai: 10, qiangdu40to50_banKuai: 0, qiangdu30to40_banKuai: 10, qiangduLess30_banKuai: 0,
        qiangduMore50_ticai: 10, qiangdu40to50_ticai: 0, qiangdu30to40_ticai: 0, qiangduLess30_ticai: 10,
        fumianzhuti: -10
    },
    topicDirection: {
        die1: -5, die2: -6, die3: -7, die4: -5, die5: -4,
        zhang1: 5, zhang2: 6, zhang3: 3, zhang4: -7,
        kongcang: -3, chushou: 3,
        yangqun1: -6, yangqun2: 6, yangqun3: -5, yangqun4: 4,
        yangqun5: 0, yangqun6: 0, yangqun7: 0,
        yangqun8: 0, yangqun9: 0, yangqun10: 0, yangqun11: 0,
        jingjiaDie1: -5,
        dapanMore1: 5, dapanLess05: -8, dapanLess1: -10,
        zhang5More20: 10, zhang5More15: 8, zhang5More10: 2, zhang5Less10: -5,
        xingxian1: 3, xingxian2: 5, xingxian3: 7, xingxian4: 10,
        xingzeng1: 5, xingzeng2: 8, xingzeng3: 10,
        xingping1: 2, xingping2: 4, xingping3: 6,
        xingbao: 10, xingwangZeng: 15,
        qiangduMore50: 10, qiangdu40to50: 0, qiangdu30to40: 0, qiangduLess30: 10,
        qiangduMore50_banKuai: 10, qiangdu40to50_banKuai: 0, qiangdu30to40_banKuai: 10, qiangduLess30_banKuai: 0,
        qiangduMore50_ticai: 10, qiangdu40to50_ticai: 0, qiangdu30to40_ticai: 0, qiangduLess30_ticai: 10,
        fumianzhuti: -10
    }
};

export function getScoreSettings(type) {
    const stored = localStorage.getItem(`scoreSettings_${type}`); // 合规：UI偏好/评分设置（§8 允许）
    if (stored) {
        return JSON.parse(stored);
    }
    return defaultScoreSettings[type] || defaultScoreSettings.recentMulti;
}

export function saveScoreSettingsToStorage(type, settings) {
    localStorage.setItem(`scoreSettings_${type}`, JSON.stringify(settings)); // 合规：UI偏好/评分设置（§8 允许）
}

export function checkHasFumianTopic(currentDate) {
    // §8 已上云（写路径双写，见 src/data/fumian-sync.js / auction-sync pullFromCloud）：hasFumianTopic_<date> 负面题材布尔标记现已由 auction-sync pullFromCloud 双写到 Supabase topic_fumian，localStorage 保留兜底。
    // 读取仍经 localStorage 兜底（本函数体不变），云读路径 loadFumianTopics() 待验证后切换；Supabase 表未建时自动降级不丢数据。
    return localStorage.getItem('hasFumianTopic_' + currentDate) === 'true';
}
