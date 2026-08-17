// curl-fetch.ts — fetch a Kambi feed URL through a headless Chromium page.
//
// WHY a browser (not curl/fetch): CloudFront in front of the feeds API now returns HTTP 410 to every
// non-browser TLS fingerprint — macOS curl (SecureTransport), Ubuntu curl (OpenSSL), Node fetch (undici),
// and even Playwright's own request client all get 410. Only a real Chromium page's in-page fetch() gets
// 200 (verified live 2026-08-16, all three Kambi hosts, CORS permissive). So we launch ONE headless
// Chromium for the whole script run and issue each GET as an in-page fetch. The function names/contract
// are unchanged, so callers (fetch-groups, fetch-participants) are untouched.
//
// One PAGE PER fetch: the participant fetcher fires a pool of concurrent GETs, and concurrent evaluate()
// on a single shared page deadlocks (one resolves, the rest hang). A page each keeps them independent.
//
// Call closeBrowser() at the end of a script's main() so the Node process can exit (a live browser keeps
// the event loop alive). CI must install the browser binary: `npx playwright install --with-deps chromium`.

import { chromium, type Browser } from "@playwright/test";

// Lazy singleton browser; the ??= hands the same launch promise to all racing first callers.
let browserP: Promise<Browser> | undefined;
const getBrowser = () => (browserP ??= chromium.launch());

// Parsed JSON on HTTP 2xx, or null on ANY failure (timeout, non-2xx, parse error). Same contract as the
// old curl version, so the caller's "null → split into children / skip leaf" fallback is unchanged.
export async function curlJsonOrNull(url: string, timeoutSec = 120): Promise<any | null> {
  let page;
  try {
    page = await (await getBrowser()).newPage();
    return await page.evaluate(
      async ({ u, ms }) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        try {
          const r = await fetch(u, { signal: ctrl.signal });
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        } finally {
          clearTimeout(t);
        }
      },
      { u: url, ms: timeoutSec * 1000 },
    );
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

// Like curlJsonOrNull but THROWS on failure — for a required single fetch (e.g. the group tree).
export async function curlJson(url: string, timeoutSec = 120): Promise<any> {
  const r = await curlJsonOrNull(url, timeoutSec);
  if (r == null) throw new Error(`fetch failed: ${url}`);
  return r;
}

// Close the shared browser so the process can exit. Safe to call if the browser was never opened.
export async function closeBrowser(): Promise<void> {
  if (!browserP) return;
  const p = browserP;
  browserP = undefined;
  await (await p).close();
}
