// §16 域拆分：bidding 域。
// 竞价的"出价/盘口"逻辑当前不在 app-core.js（其读取在 data/supabase-client.js 的 getBiddingData），
// 这里建立 bidding 域模块作为统一出口，保持架构规范中 bidding 域的目录与导出面。
import { state } from '../app-state.js';
if (!state._biddingMemCache) state._biddingMemCache = {}; // §6.1：域缓存下沉，bidding 域拥有 _biddingMemCache
export { getBiddingData } from '../../data/supabase-client.js';
