function _moduleKey(name) {
  return 'stockApp_v42_' + name;
}

function _readLegacyObject(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}'); // 合规：旧版一次性迁移读取（§8 允许，非持久化）
  } catch (e) {
    return {};
  }
}

function _isDateKey(k) {
  return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
}

function _warn(msg) {
  console.warn('[RB]', msg);
}

export { _moduleKey, _readLegacyObject, _isDateKey, _warn };
