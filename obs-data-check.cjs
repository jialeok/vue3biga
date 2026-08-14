const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

async function main() {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON);
  const dates = ['2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-17'];
  for (const date of dates) {
    const { data, error } = await client.from('auction_watchlist').select('*').eq('date', date);
    if (error) { console.log(date, 'ERR', error.message); continue; }
    const rows = data || [];
    const worker = rows.filter(r => r.source === 'worker');
    const manual = rows.filter(r => r.source !== 'worker');
    const obsManual = manual.filter(r => r.obs_auto_added === true);
    const regManual = manual.filter(r => r.obs_auto_added !== true);
    console.log(`\n=== ${date} === total=${rows.length} worker=${worker.length} manual=${manual.length}(obs=${obsManual.length}, reg=${regManual.length})`);
    if (date === '2026-08-17') {
      console.log('-- 8/17 常规组 manual 行 (obs_auto_added!=true) --');
      regManual.forEach(r => {
        const hasData = (r.volume !== undefined && r.volume !== null && r.volume !== '') || (r.yest_volume !== undefined && r.yest_volume !== null && r.yest_volume !== '');
        console.log(`   ${r.stock}  source=${r.source} obs_auto_added=${r.obs_auto_added} reg_auto_added=${(r.regular_auto_added||false)} volume=${JSON.stringify(r.volume)} yest=${JSON.stringify(r.yest_volume)} hasData=${hasData}`);
      });
      console.log('-- 8/17 观察组 manual 行 (obs_auto_added=true) --');
      obsManual.forEach(r => {
        const hasData = (r.volume !== undefined && r.volume !== null && r.volume !== '');
        console.log(`   ${r.stock} volume=${JSON.stringify(r.volume)} hasData=${hasData}`);
      });
    }
    if (date === '2026-08-14') {
      console.log('-- 8/14 manual 行明细 --');
      manual.forEach(r => {
        console.log(`   ${r.stock} source=${r.source} obs_auto_added=${r.obs_auto_added} reg_auto_added=${(r.regular_auto_added||false)} volume=${JSON.stringify(r.volume)}`);
      });
    }
    if (date === '2026-08-12' || date === '2026-08-13') {
      console.log(`-- ${date} regular manual 行 (有无数据) --`);
      regManual.forEach(r => {
        const hasData = (r.volume !== undefined && r.volume !== null && r.volume !== '') || (r.yest_volume !== undefined && r.yest_volume !== null && r.yest_volume !== '');
        console.log(`   ${r.stock} volume=${JSON.stringify(r.volume)} yest=${JSON.stringify(r.yest_volume)} hasData=${hasData}`);
      });
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
