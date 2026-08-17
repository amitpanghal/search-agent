import { chromium } from '@playwright/test';
const FEED = id => `https://feeds-eu.offering-api.kambicdn.com/feeds/api/kambi/participant/group/${id}.json`;
const b = await chromium.launch();
async function get(id, name) {
  const t0 = Date.now();
  const page = await b.newPage();
  try {
    const r = await page.evaluate(async ({u, ms}) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try { const res = await fetch(u, {signal: ctrl.signal}); return {status: res.status, ok: res.ok, len: res.ok ? (await res.text()).length : 0}; }
      catch (e) { return {err: String(e)}; }
      finally { clearTimeout(t); }
    }, {u: FEED(id), ms: 30000});
    console.log(name, id, '->', JSON.stringify(r), `(${Date.now()-t0}ms)`);
  } catch (e) { console.log(name, 'EVALUATE THREW', String(e), `(${Date.now()-t0}ms)`); }
  finally { await page.close().catch(()=>{}); }
}
await Promise.all([ get(2000050854, 'Upcoming'), get(2000091527, 'Unconfirmed') ]);
await b.close();
console.log('all done');
