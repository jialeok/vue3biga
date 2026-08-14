// 复算竞昨高光 + 验证"视图注入"在历史日期是否产生无数据影子记录
const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

const TABLE = 'auction_watchlist';
const DATES = ['2026-08-07','2026-08-10','2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-15','2026-08-17'];

function num(v){ if(v===null||v===undefined||v==='') return null; const n=parseFloat(String(v).replace(/,/g,'')); return isNaN(n)?null:n; }

async function main(){
  const { data, error } = await sb.from(TABLE).select('date,stock,volume,yest_volume,source,obs_auto_added').in('date', DATES);
  if(error){ console.error('ERR', error); return; }
  // 按 date 建索引
  const byDate = {};
  DATES.forEach(d => byDate[d] = []);
  (data||[]).forEach(r => { if(byDate[r.date]) byDate[r.date].push(r); });

  // 复算某日竞昨高光集（与 auction-sort-rules.js 一致，排除 obs_auto_added 壳）
  function highlightsFor(D){
    const dList = byDate[D] || [];
    const t1 = prevTrading(D);
    const t1List = byDate[t1] || [];
    const t1Map = {}; t1List.forEach(r => t1Map[r.stock.trim()] = r);
    const set = new Set();
    dList.forEach(r => {
      if(r.obs_auto_added === true) return;
      const name = r.stock.trim();
      const todayV = num(r.volume);
      const t1OwnV = num(r.yest_volume);
      const t1Row = t1Map[name];
      const t1V = t1Row ? num(t1Row.volume) : null;
      const t2OwnV = t1Row ? num(t1Row.yest_volume) : null;
      if(todayV===null||t1V===null) return;
      if(!(todayV>t1V)) return;
      if(t1OwnV===null||t2OwnV===null) return;
      if(!(t1OwnV>t2OwnV)) return;
      const jingRatio = todayV/t1V;
      const yestRatio = (t1OwnV===0)?null:(t1OwnV/t2OwnV);
      if(yestRatio===null) return;
      const diff = jingRatio - yestRatio;
      if(diff>0) set.add(name);
    });
    return set;
  }
  function prevTrading(d){
    const idx = DATES.indexOf(d);
    // 用 DATES 中 d 之前的最后一个
    for(let i=idx-1;i>=0;i--) return DATES[i];
    return null;
  }
  // 但 prevTrading 应严格取上一交易日，这里用 DATES 列表近似（8/07,8/10,8/11,...）
  // 实际交易日：8/07(五),8/10(一),8/11(二),8/12(三),8/13(四),8/14(五),8/17(一)
  // 所以下一交易日前一天映射：
  const REAL_PREV = {
    '2026-08-11':'2026-08-10','2026-08-12':'2026-08-11','2026-08-13':'2026-08-12',
    '2026-08-14':'2026-08-13','2026-08-17':'2026-08-14'
  };
  function prev(D){ return REAL_PREV[D] || null; }

  console.log('=== 历史日期：前日高光 vs 当天真实列表命中 ===');
  ['2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-17'].forEach(D => {
    const t1 = prev(D);
    const prevHL = highlightsFor(t1); // 前一日(D-1)的高光集 = D 应继承的观察组来源
    const dList = byDate[D] || [];
    const dWorker = dList.filter(r => r.source === 'worker');
    const dWorkerNames = new Set(dWorker.map(r => r.stock.trim()));
    const dAllNames = new Set(dList.map(r => r.stock.trim()));
    // 命中：前日高光中，在当天【带数据】的 worker 行里出现的
    const hitWorker = [...prevHL].filter(n => dWorkerNames.has(n));
    const hitAny = [...prevHL].filter(n => dAllNames.has(n));
    const injectedIfApplied = [...prevHL].filter(n => !dAllNames.has(n));
    console.log(`\n-- ${D} (前日=${t1}) --`);
    console.log(`  当天真实 worker 行数=${dWorker.length}, 全部行数=${dList.length}`);
    console.log(`  前日(${t1})竞昨高光数=${prevHL.size}`);
    console.log(`  高光中在当天【真实worker且带数据】命中的=${hitWorker.length}`);
    console.log(`  高光中在当天【任意行】命中的=${hitAny.length}`);
    console.log(`  ⇒ 若按"视图注入"会凭空补入的无数据壳=${injectedIfApplied.length}`);
    if(injectedIfApplied.length>0 && injectedIfApplied.length<=30){
      console.log(`     影子记录名单: ${injectedIfApplied.join('、')}`);
    }
  });
}
main().catch(e=>{console.error(e);process.exit(1);});
