// test-harness-ml.js
import fs from 'fs/promises';
import pLimit from 'p-limit';
import fetch from 'node-fetch';
import { chromium } from 'playwright';
import crypto from 'crypto';
import 'dotenv/config';

const TARGET_URL = process.env.TARGET_URL || 'https://alprestamo.com/blog/?utm_source=institucional&utm_medium=header&utm_source_sub=institucional-header';
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '3', 10);
const WAIT_MIN = parseInt(process.env.WAIT_MIN || '3000', 10);
const WAIT_MAX = parseInt(process.env.WAIT_MAX || '8000', 10);
const LAND_MIN = parseInt(process.env.LAND_MIN || '5000', 10);
const LAND_MAX = parseInt(process.env.LAND_MAX || '10000', 10);
const LOG_FILE = process.env.LOG_FILE || './clicks_ml.log';
const UAS_FILE = process.env.UAS_FILE || './useragents.txt';

const ML_EMAIL = process.env.ML_EMAIL; // e.g. kevinyyang15@gmail.com
const ML_PASSWORD = process.env.ML_PASSWORD; // set in env, don't hardcode
const ML_WORKSPACE = process.env.ML_WORKSPACE; // e.g. 097fdfc7-a948-4a71-a586-02d82fcaac6b
const ML_API_BASE = process.env.ML_API_BASE || 'https://api.multilogin.com'; // e.g. https://api.multilogin.com or https://app.multilogin.com
const ML_LAUNCHER = process.env.ML_LAUNCHER || 'https://launcher.mlx.yt:45001'; // launcher endpoint used to start profiles
const ML_API_VERSION_PREFIX = process.env.ML_API_VERSION_PREFIX || '/api/v2';

if (!ML_EMAIL || !ML_PASSWORD || !ML_WORKSPACE) {
  console.error('Set ML_EMAIL, ML_PASSWORD and ML_WORKSPACE in env before running.');
  process.exit(1);
}

// helpers
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min)); }
function sample(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function md5Hex(str) { return crypto.createHash('md5').update(String(str)).digest('hex'); }
const trimTrailingSlash = (str) => str.replace(/\/+$/, '');
const ensureLeadingSlash = (str) => str ? (str.startsWith('/') ? str : `/${str}`) : '';
const normalizedBase = trimTrailingSlash(ML_API_BASE);
const normalizedPrefix = trimTrailingSlash(ensureLeadingSlash(ML_API_VERSION_PREFIX || ''));
const baseEndsWithPrefix = normalizedPrefix && normalizedBase.endsWith(normalizedPrefix);
const apiBaseVersioned = baseEndsWithPrefix ? normalizedBase : trimTrailingSlash(`${normalizedBase}${ensureLeadingSlash(normalizedPrefix)}`);
const apiBaseUnversioned = baseEndsWithPrefix ? trimTrailingSlash(normalizedBase.slice(0, normalizedBase.length - normalizedPrefix.length)) || normalizedBase : normalizedBase;

function makeApiUrl(path, opts = {}) {
  const versioned = opts.versioned !== false;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (!versioned) {
    return `${apiBaseUnversioned}${cleanPath}`;
  }
  return `${apiBaseVersioned}${cleanPath}`;
}
function extractGclid(url) {
  if (!url) return null;
  const match = url.match(/[?&]gclid=([^&#]+)/i);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
async function appendLog(line) {
  const l = `${new Date().toISOString()} ${line}\n`;
  await fs.appendFile(LOG_FILE, l).catch(()=>{});
  process.stdout.write(l);
}
async function loadLines(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) { return []; }
}

/* -----------------------
   Multilogin API helpers
   ----------------------- */
async function mlSignIn(email, password) {
  const payload = {
    email,
    password: md5Hex(password),
  };
  const signinUrl = makeApiUrl('/user/signin', { versioned: false });
  await appendLog(`[AUTH] POST ${signinUrl} payload=${JSON.stringify({ email })}`);

  const res = await fetch(signinUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  await appendLog(`[AUTH] status=${res.status}`);
  if (!res.ok) throw new Error(`mlSignIn failed ${res.status}`);
  const body = await res.json();
  await appendLog(`[AUTH] responseKeys=${Object.keys(body || {}).join(',')}`);
  // expects { token: '...' } or similar
  return body.token || body.accessToken || body.data?.token;
}

// List profiles in workspace (fallback to listing all and filtering by workspace)
async function mlListProfiles(token, workspaceId) {
  const listUrlBase = makeApiUrl('/profile/list');
  const url = workspaceId ? `${listUrlBase}?workspace_id=${encodeURIComponent(workspaceId)}` : listUrlBase;
  await appendLog(`[PROFILES] GET ${url}`);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(workspaceId ? { 'workspace-id': workspaceId } : {}),
    },
  });
  await appendLog(`[PROFILES] status=${res.status}`);
  if (!res.ok) {
    const bodyText = await res.text().catch(()=>'<no-body>');
    await appendLog(`[PROFILES] errorBody=${bodyText.slice(0,400)}`);
    throw new Error('mlListProfiles failed ' + res.status);
  }
  const body = await res.json();
  await appendLog(`[PROFILES] responseType=${Array.isArray(body)?'array':typeof body}`);
  return body.data || body.profiles || body;
}

// Start a profile via launcher with automation_type=playwright
async function mlStartProfileLauncher(folderId, profileId, options = {}) {
  // Build query: automation_type=playwright&headless_mode=true
  const qs = new URLSearchParams({
    automation_type: options.automation_type || 'playwright',
    headless_mode: options.headless_mode ? 'true' : 'false',
    // other launcher options can be added
  }).toString();

  // The launcher URL pattern (common): https://launcher.mlx.yt:45001/api/v2/profile/f/:folder_id/p/:profile_id/start
  const url = `${ML_LAUNCHER}/api/v2/profile/f/${folderId}/p/${profileId}/start?${qs}`;

  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text().catch(()=>'<no-body>');
    throw new Error(`mlStartProfileLauncher failed ${res.status} ${text}`);
  }
  const data = await res.json().catch(()=>null);
  // Expected: contains automation info: { port: ..., wsEndpoint: 'ws://...' } or similar.
  return data;
}

async function mlStopProfileLauncher(folderId, profileId) {
  const url = `${ML_LAUNCHER}/api/v2/profile/f/${folderId}/p/${profileId}/stop`;
  await fetch(url, { method: 'POST' }).catch(()=>{});
}

/* -----------------------
   Actual browser flow
   ----------------------- */

async function runProfile(profile, ua, idx) {
  const prefix = `[#${idx}] profileId=${profile.id} name="${profile.name||profile.title||'profile'}"`;
  try {
    await appendLog(`${prefix} STARTING`);

    // launcher wants folder id + profile id. many APIs have profile.folderId or profile.folder
    const folderId = profile.folderId || profile.folder || profile.folder_id || 'default';
    const startRes = await mlStartProfileLauncher(folderId, profile.id, { automation_type: 'playwright', headless_mode: true });
    await appendLog(`${prefix} LAUNCHED resp=${JSON.stringify(startRes).slice(0,200)}`);

    // Attempt to find wsEndpoint or port in startRes
    const ws = startRes?.data?.ws || startRes?.automation?.wsEndpoint || startRes?.wsEndpoint || startRes?.wsUrl || startRes?.webSocketUrl;
    const port = startRes?.data?.port || startRes?.port || startRes?.automation?.port;

    let browser = null;
    if (ws) {
      await appendLog(`${prefix} connecting via wsEndpoint`);
      browser = await chromium.connect({ wsEndpoint: ws, timeout: 30000 });
    } else if (port) {
      // connectOverCDP accepts http(s) CDP endpoint like http://127.0.0.1:XXXXX
      const host = startRes?.data?.host || '127.0.0.1';
      const urlCDP = `http://${host}:${port}`;
      await appendLog(`${prefix} connecting over CDP ${urlCDP}`);
      browser = await chromium.connectOverCDP(urlCDP, { timeout: 30000 });
    } else {
      // Some installations expose a local debugging websocket at known path.
      // Best-effort try common localhost ports returned by launcher inside raw body:
      const maybe = JSON.stringify(startRes || '').match(/(ws:\/\/[^\s"']+|wss:\/\/[^\s"']+|127\.0\.0\.1:\d{3,5})/);
      if (maybe) {
        const attempt = maybe[1].startsWith('ws') ? maybe[1] : `http://${maybe[1]}`;
        await appendLog(`${prefix} attempting fallback connect to ${attempt}`);
        try {
          browser = await chromium.connect({ wsEndpoint: attempt, timeout: 20000 });
        } catch (e) { /* ignore */ }
      }
    }

    if (!browser) {
      throw new Error('Could not determine ws/port to connect to launched profile (inspect launcher response)');
    }

    // Reuse the context provided by Multilogin so its proxy/settings stay intact
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

    // Page listeners to capture navigations (similar a tu original)
    page.on('framenavigated', (frame) => {
      const u = frame.url();
      if (u) appendLog(`${prefix} NAV ${u}`);
    });

    // goto target
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.mouse.move(100 + Math.random()*300, 100 + Math.random()*200);

    // function to collect frames
    function collectFrames(root) {
      const out = [];
      const stack = [root];
      while (stack.length) {
        const f = stack.pop();
        out.push(f);
        for (const c of f.childFrames()) stack.push(c);
      }
      return out;
    }

    // try to click banners inside frames or anchors in main page
    const allFrames = collectFrames(page.mainFrame());
    const adFrames = allFrames.filter(f => {
      const url = (f.url() || '');
      return /googleads\.g\.doubleclick\.net|aswift_|\/ads\?/i.test(url);
    });

    let clickCount = 0;
    async function recordClick(targetUrl) {
      clickCount += 1;
      const gclid = extractGclid(targetUrl);
      await appendLog(`${prefix} CLICK count=${clickCount} gclid=${gclid||'null'}`);
    }

    async function processAnchor(anchorHandle, locationSource) {
      const waitTarget = (locationSource && typeof locationSource.waitForTimeout === 'function') ? locationSource : page;
      const urlSource = (locationSource && typeof locationSource.url === 'function') ? locationSource : page;

      const delay = randInt(WAIT_MIN, WAIT_MAX);
      await waitTarget.waitForTimeout(delay);
      const href = await anchorHandle.getAttribute('href').catch(()=>null);
      await anchorHandle.click({ delay: 100 }).catch(()=>{});
      const stay = randInt(LAND_MIN, LAND_MAX);
      await waitTarget.waitForTimeout(stay);

      let currentUrl = null;
      try { currentUrl = urlSource.url(); } catch (e) { currentUrl = null; }
      if (!currentUrl && urlSource !== page && typeof page.url === 'function') {
        try { currentUrl = page.url(); } catch (e) { currentUrl = null; }
      }
      await recordClick(currentUrl || href);
    }

    if (adFrames.length === 0) {
      const anchors = await page.$$('a.test-banner, .banner a, a[data-test="banner"]');
      if (anchors.length > 0) {
        for (const a of anchors) {
          await processAnchor(a, page);
        }
      } else {
        await appendLog(`${prefix} NO_BANNERS_FOUND`);
      }
    } else {
      for (const f of adFrames) {
        try {
          const anchors = await f.$$('a, area[href], [role="link"]');
          if (anchors && anchors.length > 0) {
            for (const a of anchors.slice(0,2)) {
              await processAnchor(a, f);
            }
          } else {
            const box = await f.evaluate(() => {
              const el = document.documentElement || document.body;
              return { w: el.clientWidth||320, h: el.clientHeight||100 };
            }).catch(()=>null);
            if (box) {
              const cx = Math.floor(box.w/2), cy = Math.floor(box.h/2);
              const delay = randInt(WAIT_MIN, WAIT_MAX);
              await f.waitForTimeout(delay);
              await f.click('html', { position: { x: cx, y: cy }, delay: 100 }).catch(()=>{});
              const stay = randInt(LAND_MIN, LAND_MAX);
              await f.waitForTimeout(stay);
              const frameUrl = f.url();
              await recordClick(frameUrl);
            }
          }
        } catch (err) { /* ignore */ }
      }
    }

    await appendLog(`${prefix} OK totalClicks=${clickCount}`);
    // close context and stop profile
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
    await mlStopProfileLauncher(folderId, profile.id);
    await appendLog(`${prefix} STOPPED`);
  } catch (err) {
    await appendLog(`${prefix} ERROR ${String(err.message || err)}`);
    // best effort stop profile if possible
    try { await mlStopProfileLauncher(profile.folderId || profile.folder || 'default', profile.id); } catch {}
  }
}

/* -----------------------
   main
   ----------------------- */
let STOP = false;
process.on('SIGINT', () => { console.log('SIGINT -> stopping after current batch'); STOP = true; });

async function main() {
  const uas = await loadLines(UAS_FILE);
  if (uas.length === 0) {
    uas.push('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36');
  }

  // Authenticate to Multilogin
  const token = await mlSignIn(ML_EMAIL, ML_PASSWORD);
  if (!token) throw new Error('Could not obtain Multilogin token');

  // Get profiles in workspace (structure depends on API)
  const profiles = await mlListProfiles(token, ML_WORKSPACE);
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error('No profiles found in workspace');
  }

  await appendLog(`Found ${profiles.length} profiles. Running with pool size ${POOL_SIZE}`);

  const limit = pLimit(POOL_SIZE);
  let counter = 0;

  while (!STOP) {
    const tasks = [];
    for (let i = 0; i < Math.min(POOL_SIZE, profiles.length); i++) {
      const profile = profiles[(counter + i) % profiles.length];
      const ua = sample(uas);
      tasks.push(limit(() => runProfile(profile, ua, ++counter)));
    }
    await Promise.allSettled(tasks);
  }
}

main().catch(err => {
  console.error('fatal', err);
  process.exit(1);
});