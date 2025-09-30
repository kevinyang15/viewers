// test-harness.js
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import pLimit from 'p-limit';

const TARGET_URL = process.env.TARGET_URL || 'https://alprestamo.com/blog/?utm_source=institucional&utm_medium=header&utm_source_sub=institucional-header';
const HEADLESS = (process.env.HEADLESS || '1') === '1';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '1', 10);
const WAIT_MIN = parseInt(process.env.WAIT_MIN || '3000', 10);
const WAIT_MAX = parseInt(process.env.WAIT_MAX || '8000', 10);
const LAND_MIN = parseInt(process.env.LAND_MIN || '5000', 10);
const LAND_MAX = parseInt(process.env.LAND_MAX || '10000', 10);
const LOG_FILE = process.env.LOG_FILE || './clicks.log';
const GCLID_LOG = process.env.GCLID_LOG || './gclids.log';

const PROXIES_FILE = process.env.PROXIES_FILE || './proxies.txt'; // cada línea: socks5h://user:pass@gate.decodo.com:7000
const UAS_FILE = process.env.UAS_FILE || './useragents.txt';

// helpers
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min)); }
function sample(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function loadLines(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// convierte "socks5h://user:pass@gate.decodo.com:7000" a { server: 'socks5://gate.decodo.com:7000', username, password }
function parseProxyUrl(proxyUrl) {
  try {
    // URL doesn't like socks5h scheme, replace socks5h -> socks5 for parsing but remember to preserve scheme
    const replaced = proxyUrl.replace(/^socks5h:\/\//i, 'socks5://');
    const u = new URL(replaced);
    const server = `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    const isSocks = /^socks5h?:\/\//i.test(proxyUrl);
    return { server, username, password, isSocks };
  } catch (e) {
    return null;
  }
}

async function logLine(line) {
  const l = `${new Date().toISOString()} ${line}\n`;
  await fs.appendFile(LOG_FILE, l).catch(()=>{});
  process.stdout.write(l);
}

async function logGclid(prefix, where, urlStr) {
  try {
    const url = new URL(urlStr);
    const params = url.searchParams;
    const keys = ['gclid', 'gclsrc', 'gbraid', 'wbraid', 'yclid', 'msclkid', 'fbclid'];
    const found = [];
    for (const k of keys) {
      const v = params.get(k);
      if (v) found.push(`${k}=${v}`);
    }
    if (found.length > 0) {
      const line = `${new Date().toISOString()} ${prefix} ${where} ${url.origin}${url.pathname} ${found.join('&')}\n`;
      await fs.appendFile(GCLID_LOG, line).catch(()=>{});
    }
  } catch {}
}

async function runOne(proxyStr, ua, idx) {
  const prefix = `[#${idx}] proxy=${proxyStr} ua="${ua}"`;
  const proxy = parseProxyUrl(proxyStr);
  if (!proxy) {
    await logLine(`${prefix} SKIP invalid-proxy`);
    return;
  }

  let browser;
  try {
    const launchOpts = {
      headless: HEADLESS,
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--autoplay-policy=no-user-gesture-required'
      ]
    };
    // Usar canal Chrome solo si NO es SOCKS. Bundled Chromium soporta SOCKS auth mejor.
    if (!proxy.isSocks && BROWSER_CHANNEL && BROWSER_CHANNEL !== 'chromium') {
      launchOpts.channel = BROWSER_CHANNEL;
    }
    try {
      browser = await chromium.launch(launchOpts);
    } catch (err) {
      const msg = String(err && err.message || err || '');
      if (proxy.isSocks && /socks5/i.test(msg)) {
        await logLine(`${prefix} retry without Chrome channel due to SOCKS5 error`);
        const fallbackOpts = { ...launchOpts };
        delete fallbackOpts.channel;
        browser = await chromium.launch(fallbackOpts);
      } else {
        throw err;
      }
    }

    const context = await browser.newContext({
      userAgent: ua,
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      timezoneId: 'UTC'
    });

    const page = await context.newPage();
    const seenIds = new Set();

    // Captura gclid en popups (al hacer click en banners suelen abrir nuevas tabs)
    page.on('popup', (popup) => {
      popup.on('framenavigated', (frame) => {
        const u = frame.url();
        if (u) logGclid(prefix, 'popup-navigate', u);
      });
      popup.on('request', (req) => {
        const u = req.url();
        if (u) logGclid(prefix, 'popup-request', u);
      });
    });

    // Captura gclid en la página principal
    page.on('framenavigated', (frame) => {
      const u = frame.url();
      if (u) logGclid(prefix, 'page-navigate', u);
    });
    page.on('request', (req) => {
      const u = req.url();
      if (u) logGclid(prefix, 'page-request', u);
    });

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // pequeño scroll y movimiento falso
    await page.evaluate(() => { window.scrollBy(0, 300); });
    await page.mouse.move(100 + Math.random()*300, 100 + Math.random()*200);

    // Buscar iframes de Google Ads (aswift / googleads)
    // recolectamos frames recursivamente (Google ads usa iframes anidados)
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
    const allFrames = collectFrames(page.mainFrame());
    const adFrames = allFrames.filter(f => {
      const url = f.url();
      return /googleads\.g\.doubleclick\.net|aswift_/i.test(url) || /\/ads\?/i.test(url);
    });

    if (adFrames.length === 0) {
      // también intentar encontrar anchors directos dentro de la página
      const anchors = await page.$$('a.test-banner, .banner a, a[data-test="banner"]');
      if (anchors.length > 0) {
        for (const a of anchors) {
          const delay = randInt(WAIT_MIN, WAIT_MAX);
          await page.waitForTimeout(delay);
          await a.click({ delay: 100 });
          const stay = randInt(LAND_MIN, LAND_MAX);
          await page.waitForTimeout(stay);
        }
      } else {
        await logLine(`${prefix} NO_BANNERS_FOUND`);
      }
    } else {
      // dentro de cada iframe de ads, intentar click en anchors o en el centro
      for (const f of adFrames) {
        try {
          // 1) intentamos encontrar enlaces clickeables
          const anchors = await f.$$('a, area[href], [role="link"]');
          if (anchors && anchors.length > 0) {
            for (const a of anchors.slice(0, 2)) { // clickeamos hasta 2 enlaces por frame
            const delay = randInt(WAIT_MIN, WAIT_MAX);
            await page.waitForTimeout(delay);
              await a.click({ delay: 100 });
            const stay = randInt(LAND_MIN, LAND_MAX);
            await page.waitForTimeout(stay);
            }
          } else {
            // si no hay <a>, clic en el centro del documento dentro del frame
            const box = await f.evaluate(() => {
              const el = document.documentElement || document.body;
              return { w: el.clientWidth||320, h: el.clientHeight||100 };
            }).catch(()=>null);
            if (box) {
              const cx = Math.floor(box.w/2), cy = Math.floor(box.h/2);
              await f.click('html', { position: { x: cx, y: cy }, delay: 100 }).catch(()=>{});
              const stay = randInt(LAND_MIN, LAND_MAX);
              await page.waitForTimeout(stay);
            }
          }
        } catch (err) {
          // ignore frame-specific errors
        }
      }
    }

    await logLine(`${prefix} OK`);
  } catch (err) {
    await logLine(`${prefix} ERROR ${err.message}`);
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}

let STOP = false;
process.on('SIGINT', () => { console.log('SIGINT -> stopping after current batch'); STOP = true; });

async function main() {
  const proxies = await loadLines(PROXIES_FILE);
  const uas = await loadLines(UAS_FILE);

  if (proxies.length === 0) {
    console.error('No proxies found. Crea proxies.txt con una línea por proxy (socks5h://user:pass@host:port).');
    process.exit(1);
  }
  if (uas.length === 0) {
    console.warn('No useragents found, usando user agents por defecto.');
    uas.push('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36');
  }

  let counter = 0;
  const limit = pLimit(POOL_SIZE);

  // Ejecutar indefinidamente hasta SIGINT, lanzando hasta POOL_SIZE en paralelo
  while (!STOP) {
    const tasks = [];
    for (let i=0; i<POOL_SIZE; i++) {
      const proxy = proxies[(counter + i) % proxies.length];
      const ua = sample(uas);
      tasks.push(limit(() => runOne(proxy, ua, ++counter)));
    }
    await Promise.allSettled(tasks);
  }
}

main().catch(err => {
  console.error('fatal', err);
  process.exit(1);
});