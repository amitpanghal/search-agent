import { chromium } from '@playwright/test';
const URL='https://feeds-eu.offering-api.kambicdn.com/feeds/api/kambi/participant/group/2000050854.json';
const b = await chromium.launch();

// A) in-page fetch with 20s abort
{
  const page = await b.newPage(); const t0=Date.now();
  const r = await page.evaluate(async ({u,ms})=>{
    const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms);
    try{const res=await fetch(u,{signal:c.signal}); return {status:res.status, len:(await res.text()).length};}
    catch(e){return {err:String(e).slice(0,60)};} finally{clearTimeout(t);}
  },{u:URL,ms:20000});
  console.log('A in-page fetch ->', JSON.stringify(r), `(${Date.now()-t0}ms)`);
  await page.close();
}
// B) page.goto with Playwright enforced 20s timeout
{
  const page = await b.newPage(); const t0=Date.now();
  try{
    const resp = await page.goto(URL, {timeout:20000, waitUntil:'commit'});
    const txt = await resp.text();
    console.log('B goto ->', JSON.stringify({status:resp.status(), len:txt.length}), `(${Date.now()-t0}ms)`);
  }catch(e){ console.log('B goto THREW', String(e).slice(0,80), `(${Date.now()-t0}ms)`); }
  await page.close();
}
await b.close(); console.log('done');
