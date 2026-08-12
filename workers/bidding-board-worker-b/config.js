// config.js — bidding-board-worker-b 配置
export const CONFIG = {
  FUYAO_BASE: 'https://fuyao.aicubes.cn',
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',

  ROW_SEAL: '封单家数',

  NUMCAT_URL: 'https://numcat.net/api/reference-proxy/market/emoindic-daily',
  NUMCAT_APINAME: 'emoindic_daily',
  NUMCAT_RECENT_DAYS: 10,
  SEAL_FIELD_CANDIDATES: ['owfd_0925_count', 'owfd_0925', 'seal_count_0925', 'fengdan_0925', 'fdjs_0925', 's_seal', 'seal_count'],

  EMOTION_FIELDS: {
    amount:        ['am', 'amount', 's_amount', 'total_amount', 's7', 's_amt'],
    predictVol:    ['am_pred', 'am_prednumber', 'predict_vol', 'predict_volume', 's_pv'],
    amountDiff:    ['am_diff', 'amount_diff'],
    limitUp:       ['u5', 'limit_up', 'zhangting', 'zt_count', 's1', 's4'],
    limitDown:     ['d3', 'limit_down', 'dieting', 'dt_count', 's5'],
    onceLimit:     ['u6', 'once_limit', 'yiziban', 'yzb_count', 's9'],
    highestLb:     ['l17', 'highest_lb', 'max_lb', 'highest_limit', 's10'],
    zhaban:        ['u12', 'zhaban', 'bomb', 'zhb_count', 's11'],
    zhabanRate:    ['fp108', 'zhaban_rate', 'bomb_rate', 'zhb_rate', 's12'],
  },

  JIWANG_TABLE: 'jiwang_data',
  EMOTION_TABLE: 'emotion_data',
};

export const CRON_TO_POINT = {
  '25 1 * * 2-6': 't0925-seal',
  '26 1 * * 2-6': 't0926',
  '40 1 * * 2-6': 't0926',
  '0 8 * * 2-6': 'close',
  '25 1 * * 1-5': 't0925-seal',
  '26 1 * * 1-5': 't0926',
  '40 1 * * 1-5': 't0926',
  '0 8 * * 1-5': 'close',
};

export const SEAL_COLUMN = 'time925';