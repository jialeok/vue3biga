/* 诊断：拉取 auction_watchlist 原始行，检查 8/11~8/14 是否存在
 * 「被回填量的继承空壳行(obsAutoAdded=true 且 volume 非空)」，
 * 以判断 8/14 竞昨高光=16 是否为反馈环残留虚高。 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DATES = ['2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-15','2026-08-16','2026-08-17'];

(async () => {
  const { data, error } = await sb.from('auction_watchlist').select('*').in('date', DATES);
  if (error) { console.error('QUERY ERROR', error); process.exit(1); }
  const byDate = {};
  DATES.forEach(d => byDate[d] = []);
  data.forEach(r => { if (byDate[r.date]) byDate[r.date].push(r); });

  DATES.forEach(d => {
    const rows = byDate[d] || [];
    const total = rows.length;
    const autoAdded = rows.filter(r => r.obsAutoAdded === true);
    const autoAddedFilled = autoAdded.filter(r => (r.volume || '').toString().trim() !== '');
    const filledVol = rows.filter(r => (r.volume || '').toString().trim() !== '');
    console.log('=== ' + d + ' === 总行数=' + total + ' 非空量行=' + filledVol.length);
    console.log('  obsAutoAdded 空壳行=' + autoAdded.length + '，其中被回填量(虚高嫌疑)=' + autoAddedFilled.length);
    if (autoAddedFilled.length) {
      autoAddedFilled.forEach(r => console.log('    [虚高嫌疑] ' + r.stock + ' volume=' + r.volume + ' yestVolume=' + r.yestVolume + ' code=' + (r.code||'')));
    }
    // 列出所有非空量行（竞昨高光候选），标注是否 obsAutoAdded
    const candidates = filledVol.map(r => (r.obsAutoAdded === true ? '*' : ' ') + r.stock + '(v=' + r.volume + ',yv=' + r.yestVolume + ')');
    if (candidates.length) console.log('  非空量行: ' + candidates.join('  '));
  });
  process.exit(0);
})();
