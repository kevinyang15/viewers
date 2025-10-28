// test-harness.js
import 'dotenv/config';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import pLimit from 'p-limit';

const TARGET_URL = process.env.TARGET_URL || 'https://alprestamo.com/blog/';
const SHOW_BROWSER = (process.env.SHOW_BROWSER || '0') === '1';
const DEBUG_SLOWMO = parseInt(process.env.DEBUG_SLOWMO || '250', 10);
const DEBUG_STAY_OPEN = parseInt(process.env.DEBUG_STAY_OPEN || '5000', 10);
const HEADLESS = SHOW_BROWSER ? false : (process.env.HEADLESS || '1') === '1';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '20', 10);
const WAIT_MIN = parseInt(process.env.WAIT_MIN || '1500', 10);
const WAIT_MAX = parseInt(process.env.WAIT_MAX || '4000', 10);
const LAND_MIN = parseInt(process.env.LAND_MIN || '2500', 10);
const LAND_MAX = parseInt(process.env.LAND_MAX || '6000', 10);
const LOG_FILE = process.env.LOG_FILE || './clicks.log';
const GCLID_LOG = process.env.GCLID_LOG || './gclids.log';
const CONSOLE_LOGS = (process.env.CONSOLE_LOGS || '1') === '1';
const AD_WAIT_MIN = parseInt(process.env.AD_WAIT_MIN || '2000', 10);
const AD_WAIT_MAX = parseInt(process.env.AD_WAIT_MAX || '5000', 10);
const SCROLL_ITERATIONS = parseInt(process.env.SCROLL_ITERATIONS || '2', 10);
const SCROLL_DISTANCE = parseInt(process.env.SCROLL_DISTANCE || '180', 10);
const AD_FRAME_WAIT = parseInt(process.env.AD_FRAME_WAIT || '4000', 10);
const BANNER_WAIT_TIMEOUT = parseInt(process.env.BANNER_WAIT_TIMEOUT || '12000', 10);
const BANNER_WAIT_POLL = parseInt(process.env.BANNER_WAIT_POLL || '400', 10);

const PROXIES_FILE = process.env.PROXIES_FILE || './proxies.txt'; // cada línea: socks5h://user:pass@gate.decodo.com:7000
const UAS_FILE = process.env.UAS_FILE || './useragents.txt';
const PROXY_PROTOCOL = (process.env.PROXY_PROTOCOL || 'http').replace(/:\/\/?$/, '');
const PROXY_HOST = process.env.PROXY_HOST;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_PORT_START = parseInt(process.env.PROXY_PORT_START || '10001', 10);
const PROXY_PORT_COUNT = parseInt(process.env.PROXY_PORT_COUNT || '1000', 10);
const PROXY_PORTS = process.env.PROXY_PORTS; // opcional: lista separada por comas

// helpers
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min)); }
function sample(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function isContextClosedError(err) {
  const msg = String(err && err.message || err || '');
  return /target page, context or browser has been closed/i.test(msg) || /cannot find context with specified id/i.test(msg);
}

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

function generateProxiesFromEnv() {
  if (!PROXY_HOST || !PROXY_USERNAME || !PROXY_PASSWORD) return [];
  const protocol = `${PROXY_PROTOCOL.toLowerCase()}://`;
  const ports = PROXY_PORTS
    ? PROXY_PORTS.split(',').map(p => parseInt(p.trim(), 10)).filter(Number.isFinite)
    : Array.from({ length: Math.max(PROXY_PORT_COUNT, 0) }, (_, i) => PROXY_PORT_START + i);

  return ports.map(port => {
    const userEnc = encodeURIComponent(PROXY_USERNAME);
    const passEnc = encodeURIComponent(PROXY_PASSWORD);
    return `${protocol}${userEnc}:${passEnc}@${PROXY_HOST}:${port}`;
  });
}

async function logLine(line) {
  const l = `${new Date().toISOString()} ${line}\n`;
  await fs.appendFile(LOG_FILE, l).catch(()=>{});
  if (CONSOLE_LOGS) process.stdout.write(l);
}

async function logGclid(prefix, where, urlStr, ua) {
  try {
    const url = new URL(urlStr);
    const params = url.searchParams;
    const keys = ['gclid', 'gclsrc', 'gbraid', 'wbraid', 'yclid', 'msclkid', 'fbclid'];
    const entries = [];
    let primaryValue = '';
    for (const k of keys) {
      const v = params.get(k);
      if (v) {
        entries.push(`${k}=${v}`);
        if (!primaryValue && k === 'gclid') primaryValue = v;
      }
    }
    if (entries.length > 0) {
      const uaInfo = ua ? ` ua="${ua}"` : '';
      const line = `${new Date().toISOString()} ${where} ${entries.join(' ')} page=${url.toString()}${uaInfo}\n`;
      await fs.appendFile(GCLID_LOG, line).catch(()=>{});
      if (CONSOLE_LOGS) process.stdout.write(line);
      return { gclid: primaryValue || entries[0]?.split('=')[1] || '', url: url.toString(), where };
    }
  } catch {}
  return null;
}

async function runOne(proxyStr, ua, idx) {
  const proxy = parseProxyUrl(proxyStr);
  if (!proxy) {
    await logLine(`[invalid-proxy] ${proxyStr}`);
    return;
  }
  const portMatch = proxyStr.match(/:(\d+)$/);
  const proxyPort = portMatch ? portMatch[1] : 'unknown';
  const prefix = `[port:${proxyPort} #${idx}]`;
  let gotGclid = false;
  let loggedGclidDone = false;
  let lastGclidInfo = null;

  const markGclid = (where, url) => {
    if (!gotGclid) {
      const info = logGclid(prefix, where, url, ua);
      if (info) {
        lastGclidInfo = { where: info.where, url: info.url, gclid: info.gclid };
      } else {
        lastGclidInfo = { where, url, gclid: '' };
      }
      gotGclid = true;
      if (CONSOLE_LOGS) process.stdout.write(`${prefix} gclid_captured ${where}\n`);
    }
  };

  const finishIfGclid = async () => {
    if (gotGclid && !loggedGclidDone) {
      loggedGclidDone = true;
      const detail = lastGclidInfo ? `${lastGclidInfo.where} gclid=${lastGclidInfo.gclid} page=${lastGclidInfo.url}` : '';
      await logLine(`${prefix} gclid_done ${detail}`);
      return true;
    }
    return gotGclid;
  };

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
    if (SHOW_BROWSER && DEBUG_SLOWMO > 0) {
      launchOpts.slowMo = DEBUG_SLOWMO;
    }
    // Usar canal Chrome solo si NO es SOCKS. Bundled Chromium soporta SOCKS auth mejor.
    if (!proxy.isSocks && BROWSER_CHANNEL && BROWSER_CHANNEL !== 'chromium') {
      launchOpts.channel = BROWSER_CHANNEL;
    }
    try {
      browser = await chromium.launch(launchOpts);
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (proxy.isSocks && /socks5/i.test(msg)) {
        await logLine(`${prefix} retry using --proxy-server for SOCKS5 auth`);
        const fallbackOpts = { ...launchOpts };
        delete fallbackOpts.channel;
        delete fallbackOpts.proxy;
        const baseHost = proxy.server.replace(/^[^:]+:\/\//i, '');
        const encodedUser = proxy.username ? encodeURIComponent(proxy.username) : null;
        const encodedPass = proxy.password ? encodeURIComponent(proxy.password) : null;
        const auth = encodedUser ? `${encodedUser}:${encodedPass || ''}@` : '';
        const proxyArg = `socks5://${auth}${baseHost}`;
        fallbackOpts.args = [
          ...launchOpts.args.filter(a => !/^--proxy-server=/i.test(a)),
          `--proxy-server=${proxyArg}`
        ];
        browser = await chromium.launch(fallbackOpts);
      } else if (launchOpts.channel) {
        await logLine(`${prefix} retry without Chrome channel due to launch error: ${msg}`);
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

    async function waitForBanners() {
      const start = Date.now();
      while (Date.now() - start < BANNER_WAIT_TIMEOUT) {
        const hasIns = await page.$('ins.adsbygoogle, ins[data-ad-status]');
        const hasFrames = await page.$('iframe[id*="aswift"], iframe[name*="aswift"], iframe[src*="googleads"]');
        if (hasIns || hasFrames) {
          if (CONSOLE_LOGS) process.stdout.write(`${prefix} banners_detected\n`);
          return true;
        }
        await page.waitForTimeout(BANNER_WAIT_POLL);
      }
      if (CONSOLE_LOGS) process.stdout.write(`${prefix} banners_timeout\n`);
      return false;
    }

    // Captura gclid en popups (al hacer click en banners suelen abrir nuevas tabs)
    page.on('popup', (popup) => {
      popup.on('framenavigated', (frame) => {
        const u = frame.url();
        if (u) markGclid('popup-navigate', u);
      });
      popup.on('request', (req) => {
        const u = req.url();
        if (u) markGclid('popup-request', u);
      });
    });

    // Captura gclid en la página principal
    page.on('framenavigated', (frame) => {
      const u = frame.url();
      if (u) markGclid('page-navigate', u);
    });
    page.on('request', (req) => {
      const u = req.url();
      if (u) markGclid('page-request', u);
    });

    if (await finishIfGclid()) return;

    if (SHOW_BROWSER) {
      await logLine(`${prefix} show-browser enabled (slowMo=${launchOpts.slowMo||0} stayOpen=${DEBUG_STAY_OPEN})`);
    }

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    if (await finishIfGclid()) return;

    await page.waitForTimeout(randInt(AD_WAIT_MIN, AD_WAIT_MAX));

    if (await finishIfGclid()) return;

    for (let i = 0; i < SCROLL_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 1 : -1;
      const distance = direction * (SCROLL_DISTANCE + randInt(20, 60));
      await page.mouse.wheel(0, distance);
      await page.waitForTimeout(randInt(400, 900));
      if (await finishIfGclid()) return;
    }

    await waitForBanners();

    if (await finishIfGclid()) return;

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
    const clickFrameElement = async (frameHandle) => {
      try {
        const elementHandle = await frameHandle.frameElement();
        if (!elementHandle) return false;
        return await clickElementHandle(elementHandle);
      } catch {
        return false;
      }
    };

    const blankFrames = await Promise.all(allFrames
      .filter(f => f.url() === 'about:blank')
      .map(async (f) => {
        try {
          const attrs = await f.evaluate(() => {
            const el = document.body || document.documentElement;
            return {
              title: el?.getAttribute?.('title') || '',
              id: el?.id || '',
              className: el?.className || ''
            };
          }).catch(()=>null);
          if (attrs && /ad|blank/i.test(`${attrs.title} ${attrs.id} ${attrs.className}`)) {
        await logLine(`${prefix} BLANK_FRAME_DETECTED ${JSON.stringify(attrs)}`);
            return f;
          }
        } catch {}
        return null;
      }));
    for (const frame of blankFrames.filter(Boolean)) {
      if (await finishIfGclid()) break;
      try {
        await waitForBanners();
        const clickable = await frame.$('a, button, [role="button"], [role="link"], iframe');
        if (clickable) {
          await clickable.click({ delay: 150 }).catch(()=>{});
        } else {
          const clickedElement = await clickFrameElement(frame);
          if (!clickedElement) {
            await frame.click('body, html', { delay: 150 }).catch(()=>{});
          }
        }
        const stay = randInt(LAND_MIN, LAND_MAX);
        await page.waitForTimeout(stay);
      } catch (err) {
        if (!isContextClosedError(err)) {
          await logLine(`${prefix} BLANK_FRAME_CLICK_ERROR ${err.message}`);
        }
        break;
      }
    }

    if (await finishIfGclid()) return;

    const adsByGoogleElements = await page.$$('ins.adsbygoogle, ins[data-ad-status], ins[class*="adsbygoogle"], ins[id*="google"]');
    for (const element of adsByGoogleElements) {
      if (await finishIfGclid()) break;
      try {
        await element.scrollIntoViewIfNeeded().catch(()=>{});
        await element.hover({ timeout: 2000 }).catch(()=>{});
        await element.click({ delay: 150 }).catch(()=>{});
        const iframeChild = await element.$('iframe');
        if (iframeChild) {
          await iframeChild.hover({ timeout: 2000 }).catch(()=>{});
          await iframeChild.click({ delay: 150 }).catch(()=>{});
        }
        await page.waitForTimeout(randInt(LAND_MIN, LAND_MAX));
      } catch (err) {
        if (!isContextClosedError(err)) {
          await logLine(`${prefix} ADSBYGOOGLE_CLICK_ERROR ${err.message}`);
        }
        break;
      }
    }

    if (await finishIfGclid()) return;

    const adFrames = allFrames.filter(f => {
      const url = f.url();
      return /googleads\.g\.doubleclick\.net|aswift_/i.test(url) || /\/ads\?/i.test(url);
    });

    if (adFrames.length === 0) {
      const anchors = await page.$$('a.test-banner, .banner a, a[data-test="banner"]');
      if (anchors.length > 0) {
        for (const a of anchors) {
          if (await finishIfGclid()) break;
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
      for (const f of adFrames) {
        if (await finishIfGclid()) break;
        try {
          const anchors = await f.$$('a, area[href], [role="link"]');
          if (anchors && anchors.length > 0) {
            for (const a of anchors.slice(0, 2)) {
              if (await finishIfGclid()) break;
              const delay = randInt(WAIT_MIN, WAIT_MAX);
              await page.waitForTimeout(delay);
              await a.click({ delay: 100 });
              const stay = randInt(LAND_MIN, LAND_MAX);
              await page.waitForTimeout(stay);
            }
          } else {
            const box = await f.evaluate(() => {
              const el = document.documentElement || document.body;
              return { w: el.clientWidth||320, h: el.clientHeight||100 };
            }).catch(()=>null);
            if (box) {
              if (await finishIfGclid()) break;
              const cx = Math.floor(box.w/2), cy = Math.floor(box.h/2);
              await f.click('html', { position: { x: cx, y: cy }, delay: 100 }).catch(()=>{});
              const stay = randInt(LAND_MIN, LAND_MAX);
              await page.waitForTimeout(stay);
            } else {
              await clickFrameElement(f);
            }
          }
        } catch (err) {
          if (!isContextClosedError(err)) {
            await logLine(`${prefix} AD_FRAME_ERROR ${err.message}`);
          }
        }
      }
    }

    await logLine(`${prefix} OK`);

    if (SHOW_BROWSER && DEBUG_STAY_OPEN > 0) {
      await page.waitForTimeout(DEBUG_STAY_OPEN);
    }
  } catch (err) {
    await logLine(`${prefix} ERROR ${err.message}`);
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}

let STOP = false;
process.on('SIGINT', () => { console.log('SIGINT -> stopping after current batch'); STOP = true; });

async function main() {
  let proxies = await loadLines(PROXIES_FILE);
  if (proxies.length === 0) {
    proxies = generateProxiesFromEnv();
    if (proxies.length > 0) {
      console.log(`Generated ${proxies.length} proxies from env configuration.`);
    }
  }
  const uas = await loadLines(UAS_FILE);

  if (proxies.length === 0) {
    console.error('No proxies found. Crea proxies.txt o define PROXY_HOST/USERNAME/PASSWORD para generar proxies via env.');
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