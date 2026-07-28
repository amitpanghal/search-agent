// curl-fetch.ts — fetch a URL via the curl BINARY instead of Node's fetch.
//
// WHY: the Kambi feeds API fingerprint-blocks Node's undici client — after a burst of requests it returns
// HTTP 410 to `fetch` for every group, while curl (a different TLS/HTTP fingerprint) keeps getting 200.
// Verified live 2026-07-19. curl streams the body to a temp FILE (`-o`), so multi-MB responses never hit
// execFile's stdout maxBuffer, and each call uses a unique temp path so concurrent fetches don't collide.

import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const pexec = promisify(execFile);

// Parsed JSON on HTTP 2xx, or null on ANY failure (timeout, non-2xx via --fail, parse error).
export async function curlJsonOrNull(url: string, timeoutSec = 120): Promise<any | null> {
  const tmp = join(tmpdir(), `kfetch-${randomBytes(6).toString("hex")}.json`);
  try {
    await pexec("curl", ["-s", "--fail", "--max-time", String(timeoutSec), "-o", tmp, url]);
    return JSON.parse(await readFile(tmp, "utf8"));
  } catch {
    return null;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// Like curlJsonOrNull but THROWS on failure — for a required single fetch (e.g. the group tree).
export async function curlJson(url: string, timeoutSec = 120): Promise<any> {
  const r = await curlJsonOrNull(url, timeoutSec);
  if (r == null) throw new Error(`curl fetch failed: ${url}`);
  return r;
}
