import { state } from '../logic/app-state.js';

const MODULE_KEYS = ['stocks', 'rank', 'multi', 'hotspot', 'pattern', 'tagTitles'];

const _stocksMemCache = state._stocksMemCache = {};
const _rankMemCache = state._rankMemCache = {};
const _multiMemCache = state._multiMemCache = {};
const _hotspotMemCache = state._hotspotMemCache = {};
const _patternMemCache = state._patternMemCache = {};
const _tagTitlesMemCache = state._tagTitlesMemCache = {};

const _caches = {
  stocks: _stocksMemCache,
  rank: _rankMemCache,
  multi: _multiMemCache,
  hotspot: _hotspotMemCache,
  pattern: _patternMemCache,
  tagTitles: _tagTitlesMemCache
};

const _dirty = {
  stocks: new Set(),
  rank: new Set(),
  multi: new Set(),
  hotspot: new Set(),
  pattern: new Set(),
  tagTitles: new Set()
};

const _lastPushed = {
  stocks: {},
  rank: {},
  multi: {},
  hotspot: {},
  pattern: {},
  tagTitles: {}
};

export {
  MODULE_KEYS,
  _stocksMemCache,
  _rankMemCache,
  _multiMemCache,
  _hotspotMemCache,
  _patternMemCache,
  _tagTitlesMemCache,
  _caches,
  _dirty,
  _lastPushed
};
