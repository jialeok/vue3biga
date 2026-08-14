// 一次性清理：删除已抓取日期里"无成交量的继承壳"（obs_auto_added=true 或 source='manual' 且 volume 空）
// 仅限"该日期存在真实数据行"的日期——保留纯继承预览日（整页都是壳、无真实数据）。
// 分页拉取全部行（绕过 Supabase 1000 行默认上限）。
const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
const TABLE = 'auction_watchlist';

function isEmpty(v){ return v === null || v === undefined || v === ''; }
function isGhost(r){ return (r.obs_auto_added === true || r.source === 'manual') && isEmpty(r.volume); }

async function fetchAll(){
  let all = [], from = 0, size = 1000;
  while (true) {
    const { data, error } = await sb.from(TABLE).select('date,stock,volume,obs_auto_added,source').range(from, from + size - 1);
    if (error) { console.error('ERR', error); process.exit(1); }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

async function main(){
  const data = await fetchAll();
  console.log(`共拉取 ${data.length} 行`);
  const byDate = {};
  data.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });

  let totalDel = 0;
  const plan = [];
  Object.keys(byDate).sort().forEach(date => {
    const rows = byDate[date];
    const hasReal = rows.some(r => !isEmpty(r.volume));
    if (!hasReal) return; // 纯继承预览日，保留壳
    const ghosts = rows.filter(isGhost);
    if (ghosts.length) {
      plan.push({ date, stocks: ghosts.map(g => g.stock) });
      totalDel += ghosts.length;
      console.log(`清理 ${date}: ${ghosts.length} 只无数据壳 [${ghosts.map(g=>`${g.stock}(${g.obs_auto_added?'obs':'manual'})`).join('、')}]`);
    }
  });

  if (!plan.length) { console.log('无需要清理的壳'); return; }
  console.log(`\n计划删除 ${totalDel} 行。开始执行...`);
  for (const p of plan) {
    const { error: delErr } = await sb.from(TABLE).delete().eq('date', p.date).in('stock', p.stocks);
    if (delErr) console.error(`删除 ${p.date} 失败:`, delErr);
    else console.log(`已删除 ${p.date} ${p.stocks.length} 行`);
  }
  console.log('清理完成。');
}
main().catch(e=>{console.error(e);process.exit(1);});
