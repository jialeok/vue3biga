// entry.js — Vite ES module 入口
// 所有模块导出挂到 window 上
import * as _mod_0 from './data/api/fuyao-proxy.js';
import * as _mod_1 from './data/api/numcat-proxy.js';
import * as _mod_2 from './data/auction-data.js';
import * as _mod_3 from './data/bidding-data.js';
import * as _mod_4 from './data/daily-highlights.js';
import * as _mod_5 from './data/debug-log.js';
import * as _mod_6 from './data/hot-stocks.js';
import * as _mod_7 from './data/jiwang-data.js';
import * as _mod_8 from './data/remaining-boards.js';
import * as _mod_9 from './data/session-and-shield.js';
import * as _mod_10 from './data/stock-code-map.js';
import * as _mod_11 from './data/stock-topics.js';
import * as _mod_12 from './data/supabase-client.js';
import * as _mod_13 from './data/watchlist-and-metrics.js';
import * as _mod_14 from './logic/app-core.js';
import * as _mod_15 from './logic/auction-sort-rules.js';
import * as _mod_15b from './logic/sort-rules-extra.js';
import * as _mod_16 from './logic/scope-helpers.js';
import * as _mod_17 from './logic/tag-rules.js';
import * as _mod_18 from './logic/topic-rules.js';
import * as _mod_19 from './logic/trend-chart-calc.js';
import * as _mod_20 from './logic/workflows/ai-vision-import.js';
import * as _mod_21 from './logic/workflows/auction-sync.js';
import * as _mod_22 from './main.js';
import * as _mod_23 from './stores/auctionStore.js';
import * as _mod_23b from './stores/eventBus.js';
import * as _mod_24 from './ui/app-core-ui.js';
import * as _mod_25 from './ui/app-init.js';
import * as _mod_26 from './ui/auction-pages.js';
import * as _mod_27 from './ui/auction-render.js';
import * as _mod_28 from './ui/auction-trend.js';
import * as _mod_29 from './ui/auction-vue-mount.js';
import * as _mod_30 from './ui/auth-ui.js';
import * as _mod_31 from './ui/boards-bidding.js';
import * as _mod_32 from './ui/boards-duiban.js';
import * as _mod_33 from './ui/boards-emotion.js';
import * as _mod_34 from './ui/boards-etf.js';
import * as _mod_35 from './ui/boards-jiwang.js';
import * as _mod_36 from './ui/boards-multi.js';
import * as _mod_37 from './ui/boards-pattern.js';
import * as _mod_38 from './ui/boards-rank.js';
import * as _mod_39 from './ui/boards-stats.js';
import * as _mod_40 from './ui/boards-stocks.js';
import * as _mod_41 from './ui/boards-tag-titles.js';
import * as _mod_42 from './ui/components/auction-components.js';
import * as _mod_43 from './ui/components/boards-vue.js';
import * as _mod_44 from './ui/components/rank-vue.js';
import * as _mod_45 from './ui/composables/auction-composables.js';
import * as _mod_46 from './ui/dashboards.js';
import * as _mod_47 from './ui/debug-log-ui.js';
import * as _mod_48 from './ui/interactions/history-gap-pct-modal.js';

try { Object.assign(window, _mod_0); } catch(e) { console.warn('Failed to assign ./data/api/fuyao-proxy.js:', e.message); }
try { Object.assign(window, _mod_1); } catch(e) { console.warn('Failed to assign ./data/api/numcat-proxy.js:', e.message); }
try { Object.assign(window, _mod_2); } catch(e) { console.warn('Failed to assign ./data/auction-data.js:', e.message); }
try { Object.assign(window, _mod_3); } catch(e) { console.warn('Failed to assign ./data/bidding-data.js:', e.message); }
try { Object.assign(window, _mod_4); } catch(e) { console.warn('Failed to assign ./data/daily-highlights.js:', e.message); }
try { Object.assign(window, _mod_5); } catch(e) { console.warn('Failed to assign ./data/debug-log.js:', e.message); }
try { Object.assign(window, _mod_6); } catch(e) { console.warn('Failed to assign ./data/hot-stocks.js:', e.message); }
try { Object.assign(window, _mod_7); } catch(e) { console.warn('Failed to assign ./data/jiwang-data.js:', e.message); }
try { Object.assign(window, _mod_8); } catch(e) { console.warn('Failed to assign ./data/remaining-boards.js:', e.message); }
try { Object.assign(window, _mod_9); } catch(e) { console.warn('Failed to assign ./data/session-and-shield.js:', e.message); }
try { Object.assign(window, _mod_10); } catch(e) { console.warn('Failed to assign ./data/stock-code-map.js:', e.message); }
try { Object.assign(window, _mod_11); } catch(e) { console.warn('Failed to assign ./data/stock-topics.js:', e.message); }
try { Object.assign(window, _mod_12); } catch(e) { console.warn('Failed to assign ./data/supabase-client.js:', e.message); }
try { Object.assign(window, _mod_13); } catch(e) { console.warn('Failed to assign ./data/watchlist-and-metrics.js:', e.message); }
try { Object.assign(window, _mod_14); } catch(e) { console.warn('Failed to assign ./logic/app-core.js:', e.message); }
try { Object.assign(window, _mod_15); } catch(e) { console.warn('Failed to assign ./logic/auction-sort-rules.js:', e.message); }
try { Object.assign(window, _mod_15b); } catch(e) { console.warn('Failed to assign ./logic/sort-rules-extra.js:', e.message); }
try { Object.assign(window, _mod_16); } catch(e) { console.warn('Failed to assign ./logic/scope-helpers.js:', e.message); }
try { Object.assign(window, _mod_17); } catch(e) { console.warn('Failed to assign ./logic/tag-rules.js:', e.message); }
try { Object.assign(window, _mod_18); } catch(e) { console.warn('Failed to assign ./logic/topic-rules.js:', e.message); }
try { Object.assign(window, _mod_19); } catch(e) { console.warn('Failed to assign ./logic/trend-chart-calc.js:', e.message); }
try { Object.assign(window, _mod_20); } catch(e) { console.warn('Failed to assign ./logic/workflows/ai-vision-import.js:', e.message); }
try { Object.assign(window, _mod_21); } catch(e) { console.warn('Failed to assign ./logic/workflows/auction-sync.js:', e.message); }
try { Object.assign(window, _mod_22); } catch(e) { console.warn('Failed to assign ./main.js:', e.message); }
try { Object.assign(window, _mod_23); } catch(e) { console.warn('Failed to assign ./stores/auctionStore.js:', e.message); }
try { Object.assign(window, _mod_23b); } catch(e) { console.warn('Failed to assign ./stores/eventBus.js:', e.message); }
try { Object.assign(window, _mod_24); } catch(e) { console.warn('Failed to assign ./ui/app-core-ui.js:', e.message); }
try { Object.assign(window, _mod_25); } catch(e) { console.warn('Failed to assign ./ui/app-init.js:', e.message); }
try { Object.assign(window, _mod_26); } catch(e) { console.warn('Failed to assign ./ui/auction-pages.js:', e.message); }
try { Object.assign(window, _mod_27); } catch(e) { console.warn('Failed to assign ./ui/auction-render.js:', e.message); }
try { Object.assign(window, _mod_28); } catch(e) { console.warn('Failed to assign ./ui/auction-trend.js:', e.message); }
try { Object.assign(window, _mod_29); } catch(e) { console.warn('Failed to assign ./ui/auction-vue-mount.js:', e.message); }
try { Object.assign(window, _mod_30); } catch(e) { console.warn('Failed to assign ./ui/auth-ui.js:', e.message); }
try { Object.assign(window, _mod_31); } catch(e) { console.warn('Failed to assign ./ui/boards-bidding.js:', e.message); }
try { Object.assign(window, _mod_32); } catch(e) { console.warn('Failed to assign ./ui/boards-duiban.js:', e.message); }
try { Object.assign(window, _mod_33); } catch(e) { console.warn('Failed to assign ./ui/boards-emotion.js:', e.message); }
try { Object.assign(window, _mod_34); } catch(e) { console.warn('Failed to assign ./ui/boards-etf.js:', e.message); }
try { Object.assign(window, _mod_35); } catch(e) { console.warn('Failed to assign ./ui/boards-jiwang.js:', e.message); }
try { Object.assign(window, _mod_36); } catch(e) { console.warn('Failed to assign ./ui/boards-multi.js:', e.message); }
try { Object.assign(window, _mod_37); } catch(e) { console.warn('Failed to assign ./ui/boards-pattern.js:', e.message); }
try { Object.assign(window, _mod_38); } catch(e) { console.warn('Failed to assign ./ui/boards-rank.js:', e.message); }
try { Object.assign(window, _mod_39); } catch(e) { console.warn('Failed to assign ./ui/boards-stats.js:', e.message); }
try { Object.assign(window, _mod_40); } catch(e) { console.warn('Failed to assign ./ui/boards-stocks.js:', e.message); }
try { Object.assign(window, _mod_41); } catch(e) { console.warn('Failed to assign ./ui/boards-tag-titles.js:', e.message); }
try { Object.assign(window, _mod_42); } catch(e) { console.warn('Failed to assign ./ui/components/auction-components.js:', e.message); }
try { Object.assign(window, _mod_43); } catch(e) { console.warn('Failed to assign ./ui/components/boards-vue.js:', e.message); }
try { Object.assign(window, _mod_44); } catch(e) { console.warn('Failed to assign ./ui/components/rank-vue.js:', e.message); }
try { Object.assign(window, _mod_45); } catch(e) { console.warn('Failed to assign ./ui/composables/auction-composables.js:', e.message); }
try { Object.assign(window, _mod_46); } catch(e) { console.warn('Failed to assign ./ui/dashboards.js:', e.message); }
try { Object.assign(window, _mod_47); } catch(e) { console.warn('Failed to assign ./ui/debug-log-ui.js:', e.message); }
try { Object.assign(window, _mod_48); } catch(e) { console.warn('Failed to assign ./ui/interactions/history-gap-pct-modal.js:', e.message); }
