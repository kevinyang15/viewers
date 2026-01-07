// test-harness.js
import 'dotenv/config';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const TARGET_URL = process.env.TARGET_URL || 'https://blog.monefin.net/';
const SHOW_BROWSER = (process.env.SHOW_BROWSER || '0') === '1';
const DEBUG_SLOWMO = parseInt(process.env.DEBUG_SLOWMO || '250', 10);
const DEBUG_STAY_OPEN = parseInt(process.env.DEBUG_STAY_OPEN || '5000', 10);
const HEADLESS = SHOW_BROWSER ? false : (process.env.HEADLESS || '1') === '1';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '0', 10);
const WAIT_MIN = parseInt(process.env.WAIT_MIN || '150', 10);
const WAIT_MAX = parseInt(process.env.WAIT_MAX || '350', 10);
const LAND_MIN = parseInt(process.env.LAND_MIN || '300', 10);
const LAND_MAX = parseInt(process.env.LAND_MAX || '700', 10);
const LOG_FILE = process.env.LOG_FILE || './clicks.log';
const GCLID_LOG = process.env.GCLID_LOG || './gclids.log';
const CONSOLE_LOGS = (process.env.CONSOLE_LOGS || '1') === '1';
const AD_WAIT_MIN = parseInt(process.env.AD_WAIT_MIN || '80', 10);
const AD_WAIT_MAX = parseInt(process.env.AD_WAIT_MAX || '180', 10);
const SCROLL_ITERATIONS = parseInt(process.env.SCROLL_ITERATIONS || '2', 10);
const SCROLL_DISTANCE = parseInt(process.env.SCROLL_DISTANCE || '180', 10);
const AD_FRAME_WAIT = parseInt(process.env.AD_FRAME_WAIT || '2200', 10);
const BANNER_WAIT_TIMEOUT = parseInt(process.env.BANNER_WAIT_TIMEOUT || '4200', 10);
const BANNER_WAIT_POLL = parseInt(process.env.BANNER_WAIT_POLL || '120', 10);
const POST_CLICK_WAIT = parseInt(process.env.POST_CLICK_WAIT || '500', 10);

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
  return /target page, context or browser has been closed/i.test(msg) || /cannot find context with specified id/i.test(msg) || /ERR_ABORTED/i.test(msg) || /net::ERR_/i.test(msg);
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

function extractPortNumber(str) {
  if (typeof str !== 'string') return NaN;
  const match = str.match(/:(\d+)(?:[^\d]|$)/);
  return match ? parseInt(match[1], 10) : NaN;
}

function sortProxiesByPort(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const mapped = list.map((value, idx) => ({ value, port: extractPortNumber(value), idx }));
  const numeric = mapped.filter(item => Number.isFinite(item.port)).sort((a, b) => a.port - b.port);
  const nonNumeric = mapped.filter(item => !Number.isFinite(item.port)).sort((a, b) => a.idx - b.idx);
  return [...numeric.map(item => item.value), ...nonNumeric.map(item => item.value)];
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
      try {
        console.log(`${prefix} gclid ${where} ${entries.join(' ')} page=${url.toString()}`);
      } catch {}
      const picked = primaryValue || (entries[0] ? entries[0].split('=')[1] : '');
      return { where, url: url.toString(), gclid: picked };
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
  let aborted = false;

  const markGclid = async (where, url) => {
    if (!gotGclid) {
      const info = await logGclid(prefix, where, url, ua);
      if (info) {
        lastGclidInfo = info;
        gotGclid = true;
        if (CONSOLE_LOGS) process.stdout.write(`${prefix} gclid_captured ${where}\n`);
        // Close any popups and the context once a gclid is captured
        try {
          for (const p of page.context().pages()) {
            if (p !== page) await p.close({ runBeforeUnload: false }).catch(()=>{});
          }
          await page.waitForTimeout(POST_CLICK_WAIT).catch(()=>{});
          await page.close({ runBeforeUnload: false }).catch(()=>{});
        } catch {}
        aborted = true;
      }
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

  const handleContextClosed = async (err, tag) => {
    if (!isContextClosedError(err)) return false;
    if (!gotGclid) {
      await abortWithError(`${tag} CONTEXT_CLOSED`);
    }
    return true;
  };

  const abortWithError = async (msg) => {
    aborted = true;
    await logLine(`${prefix} ${msg}`);
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

    await context.addInitScript(() => {
      const forceSameTab = (event) => {
        const anchor = event?.target?.closest?.('a[target="_blank"]');
        if (anchor) {
          anchor.removeAttribute('target');
        }
      };
      window.addEventListener('click', forceSameTab, true);
      window.open = function(url) {
        if (url) {
          try {
            window.location.href = url;
          } catch (err) {
            /* noop */
          }
        }
        return window;
      };
    });

    await context.route('**/*', (route) => {
      const request = route.request();
      const type = request.resourceType();
      const url = request.url();
      const allowAds = /googleads\.g\.doubleclick\.net|doubleclick\.net|googleadservices\.com/i.test(url);
      if (!allowAds && (type === 'image' || type === 'media' || type === 'font')) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();

    async function waitForBanners() {
      try {
        await page.waitForSelector(
          'ins.adsbygoogle, ins[data-ad-status], iframe[id*="aswift"], iframe[name*="aswift"], iframe[src*="googleads"], div[class*="adsbygoogle"], div[data-ad-client]',
          { timeout: BANNER_WAIT_TIMEOUT }
        );
        if (CONSOLE_LOGS) process.stdout.write(`${prefix} banners_detected\n`);
        return true;
      } catch {
        if (CONSOLE_LOGS) process.stdout.write(`${prefix} banners_timeout\n`);
        return false;
      }
    }

    // Captura gclid en popups (al hacer click en banners suelen abrir nuevas tabs)
    page.on('popup', (popup) => {
      const handlePopupUrl = async (where, url) => {
        if (url) {
          await markGclid(where, url);
        }
      };
      popup.on('framenavigated', async (frame) => {
        const u = frame.url();
        if (u) await handlePopupUrl('popup-navigate', u);
      });
      popup.on('request', async (req) => {
        const u = req.url();
        if (u) await handlePopupUrl('popup-request', u);
      });
      const safeClose = async () => {
        const finalUrl = popup.url();
        if (finalUrl) await handlePopupUrl('popup-final', finalUrl);
        await popup.close({ runBeforeUnload: false }).catch(()=>{});
      };
      popup.once('domcontentloaded', safeClose);
      popup.once('load', safeClose);
    });

    // Captura gclid en la página principal
    page.on('framenavigated', async (frame) => {
      const u = frame.url();
      if (u) await markGclid('page-navigate', u);
    });
    page.on('request', async (req) => {
      const u = req.url();
      if (u) await markGclid('page-request', u);
    });

    if (await finishIfGclid()) return;

    if (SHOW_BROWSER) {
      await logLine(`${prefix} show-browser enabled (slowMo=${launchOpts.slowMo||0} stayOpen=${DEBUG_STAY_OPEN})`);
    }

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    if (await finishIfGclid()) return;

    await page.waitForTimeout(randInt(AD_WAIT_MIN, AD_WAIT_MAX));

    if (await finishIfGclid()) return;

    const bannersFound = await waitForBanners();
    if (!bannersFound && !gotGclid && !aborted) {
      await abortWithError('NO_BANNERS_TIMEOUT');
    }

    if (await finishIfGclid() || aborted) return;

    async function waitForGclid(timeoutMs = AD_FRAME_WAIT) {
      const start = Date.now();
      while (!gotGclid && !aborted && Date.now() - start < timeoutMs) {
        await page.waitForTimeout(150).catch(()=>{});
      }
      return gotGclid;
    }

    async function clickBoundingBox(handle, label, positionOrOptions, maybeOptions) {
      try {
        const box = await handle.boundingBox();
        if (!box) return { clicked: false, gclid: false };
        await handle.scrollIntoViewIfNeeded().catch(()=>{});
        let positionFn;
        let options;
        if (typeof positionOrOptions === 'function' || positionOrOptions === undefined) {
          positionFn = positionOrOptions;
          options = maybeOptions || {};
        } else {
          options = positionOrOptions || {};
          positionFn = undefined;
        }
        const {
          timeout = AD_FRAME_WAIT,
          waitAfter = randInt(AD_WAIT_MIN, AD_WAIT_MAX),
          postClickWait = POST_CLICK_WAIT,
          minDelay = 50,
          maxDelay = 120
        } = options;

        let relX;
        let relY;
        if (typeof positionFn === 'function') {
          const custom = positionFn(box) || {};
          if (Number.isFinite(custom.x) && Number.isFinite(custom.y)) {
            relX = custom.x;
            relY = custom.y;
          }
        }
        if (!Number.isFinite(relX) || !Number.isFinite(relY)) {
          const jitterX = randInt(-10, 10);
          const jitterY = randInt(-10, 10);
          relX = box.width / 2 + jitterX;
          relY = box.height / 2 + jitterY;
        }
        relX = Math.max(2, Math.min(box.width - 2, relX));
        relY = Math.max(2, Math.min(box.height - 2, relY));
        let navigated = false;
        let popupOpened = false;
        let timedOut = false;
        const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout })
          .then(() => { navigated = true; return true; })
          .catch(()=>null);
        const popupPromise = page.waitForEvent('popup', { timeout })
          .then(() => { popupOpened = true; return true; })
          .catch(()=>null);
        const waiters = [navPromise, popupPromise];
        if (waitAfter > 0) {
          waiters.push(page.waitForTimeout(waitAfter).then(() => { timedOut = true; return null; }).catch(()=>null));
        }
        await handle.click({ delay: randInt(minDelay, maxDelay), position: { x: relX, y: relY } }).catch(async () => {
          const x = Math.round(box.x + relX);
          const y = Math.round(box.y + relY);
          await page.mouse.move(x, y, { steps: 4 }).catch(()=>{});
          await page.mouse.click(x, y, { delay: randInt(minDelay, maxDelay) }).catch(()=>{});
        });
        await Promise.race(waiters).catch(()=>null);
        await logLine(`${prefix} banner_click ${label}`);
        const captured = await waitForGclid(timeout + postClickWait);
        return { clicked: true, gclid: captured, navigated, popupOpened, timedOut };
      } catch (err) {
        await logLine(`${prefix} banner_click_error ${label} ${err.message}`);
        return { clicked: false, gclid: false };
      }
    }

    async function preferIframeHandle(handle) {
      if (!handle) return null;
      const tagName = await handle.evaluate((el) => el?.tagName?.toLowerCase?.() || '').catch(()=>'');
      if (tagName === 'iframe') return handle;
      const nestedIframe = await handle.$('iframe[id*="aswift"], iframe[id*="google"], iframe');
      if (nestedIframe) return nestedIframe;
      return handle;
    }

    async function clickFrame(frame, label) {
      try {
        const anchors = await frame.$$('a, area[href], [role="link"], button, [role="button"]');
        if (anchors && anchors.length > 0) {
          const target = anchors[0];
          await target.evaluate((el) => {
            if (el && typeof el.removeAttribute === 'function' && el.getAttribute('target') === '_blank') {
              el.removeAttribute('target');
            }
          }).catch(()=>{});
          let navigated = false;
          let popupOpened = false;
          const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: AD_FRAME_WAIT })
            .then(() => { navigated = true; return true; })
            .catch(()=>null);
          const popupPromise = page.waitForEvent('popup', { timeout: AD_FRAME_WAIT })
            .then(() => { popupOpened = true; return true; })
            .catch(()=>null);
          await target.click({ delay: 120 }).catch(()=>{});
          await Promise.race([
            navPromise,
            popupPromise,
            page.waitForTimeout(randInt(AD_WAIT_MIN, AD_WAIT_MAX)).catch(()=>null)
          ]).catch(()=>null);
          await logLine(`${prefix} frame_anchor_click ${label}`);
          const captured = await waitForGclid(AD_FRAME_WAIT + POST_CLICK_WAIT);
          return { clicked: true, gclid: captured, navigated, popupOpened };
        }
        let navigated = false;
        let popupOpened = false;
        const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: AD_FRAME_WAIT })
          .then(() => { navigated = true; return true; })
          .catch(()=>null);
        const popupPromise = page.waitForEvent('popup', { timeout: AD_FRAME_WAIT })
          .then(() => { popupOpened = true; return true; })
          .catch(()=>null);
        await frame.click('body, html', { delay: 120 }).catch(()=>{});
        await Promise.race([
          navPromise,
          popupPromise,
          page.waitForTimeout(randInt(AD_WAIT_MIN, AD_WAIT_MAX)).catch(()=>null)
        ]).catch(()=>null);
        await logLine(`${prefix} frame_generic_click ${label}`);
        const captured = await waitForGclid(AD_FRAME_WAIT + POST_CLICK_WAIT);
        return { clicked: true, gclid: captured, navigated, popupOpened };
      } catch (err) {
        await logLine(`${prefix} frame_click_error ${label} ${err.message}`);
        return { clicked: false, gclid: false };
      }
    }

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

    async function clickFirstBanner() {
      let attempts = 0;
      let clickedWithoutGclid = false;
      let clickAttemptFailed = false;
      async function clickBottomBanner() {
        const anchorSelectors = [
          'ins.adsbygoogle[data-anchor-status="displayed"]',
          'ins.adsbygoogle[data-anchor-shown="true"]',
          'ins.adsbygoogle[style*="position: fixed"][style*="bottom"]',
          'ins[data-anchor-status][style*="position: fixed"][style*="bottom"]',
          'div[id^="aswift_"][id$="_host"][style*="position: fixed"][style*="bottom"]'
        ];
        const anchorFrameSelectors = 'iframe[id*="anchor"], iframe[name*="anchor"], iframe[src*="anchor"], iframe[style*="position: fixed"][style*="bottom"], div[id^="google_ads_iframe_"][style*="position: fixed"][style*="bottom"] iframe';

        async function clickTextualContent(targetHandle, baseLabel, maxClicks) {
          try {
            const selectors = ['a', 'button', '[role="button"]', '[onclick]', '[data-href]', '[data-url]', '[data-link]', '[href]'];
            const nodes = [];
            for (const selector of selectors) {
              const matches = await targetHandle.$$(selector).catch(()=>[]);
              if (matches && matches.length) nodes.push(...matches);
            }
            if (nodes.length === 0) return null;
            const results = [];
            const seenTexts = new Set();
            let clicks = 0;
            for (const node of nodes) {
              if (clicks >= maxClicks) break;
              let text = '';
              try {
                text = await node.evaluate((el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim());
              } catch {
                await node.dispose?.().catch(()=>{});
                return null;
              }
              if (!text) {
                await node.dispose?.().catch(()=>{});
                continue;
              }
              const key = text.toLowerCase();
              if (seenTexts.has(key)) {
                await node.dispose?.().catch(()=>{});
                continue;
              }
              seenTexts.add(key);
              clicks += 1;
              const labelText = text.length > 40 ? `${text.slice(0, 37)}…` : text;
              const res = await clickBoundingBox(node, `${baseLabel}|text:${labelText}`, {
                timeout: Math.min(AD_FRAME_WAIT, 1500),
                waitAfter: 100,
                postClickWait: 200,
                minDelay: 28,
                maxDelay: 60
              });
              results.push({ ...res, text });
              await node.dispose?.().catch(()=>{});
              if (!res.clicked || res.gclid) break;
            }
            if (results.length === 0) return null;
            return { results };
          } catch {
            return null;
          }
        }

        try {
          await page.evaluate(() => {
            try {
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
            } catch {
              window.scrollTo(0, document.body.scrollHeight);
            }
          });
        } catch {}
        await page.waitForTimeout(randInt(250, 450)).catch(()=>{});

        const candidates = [];
        for (const selector of anchorSelectors) {
          const found = await page.$$(selector);
          for (const handle of found) {
            candidates.push({ handle, label: `bottom-anchor:${selector}` });
          }
          if (found.length === 0) {
            try {
              const awaited = await page.waitForSelector(selector, { state: 'visible', timeout: 2500 });
              if (awaited) candidates.push({ handle: awaited, label: `bottom-anchor:${selector}` });
            } catch {}
          }
        }

        const extraFrames = await page.$$(anchorFrameSelectors).catch(()=>[]);
        for (const handle of extraFrames || []) {
          candidates.push({ handle, label: 'bottom-anchor:iframe' });
        }

        for (const candidate of candidates) {
          const { handle, label } = candidate;
          if (!handle) continue;
          if (await finishIfGclid() || aborted) {
            return { attempted: 0, gclid: true, clickedWithoutGclid, clickAttemptFailed };
          }
          const preferred = await preferIframeHandle(handle);
          if (!preferred) continue;
          let localAttempts = 0;
          let localRedirect = false;
          const maxRapidClicks = Math.max(5, parseInt(process.env.BOTTOM_MULTI_CLICKS || '5', 10));
          const fractions = [0.18, 0.36, 0.54, 0.72, 0.5];
          const rapidResults = [];

          const textClicks = await clickTextualContent(preferred, label, maxRapidClicks);
          if (textClicks && textClicks.results) {
            const textResults = textClicks.results.filter(Boolean);
            const clickedTextCount = textResults.filter(r => r.clicked).length;
            if (clickedTextCount > 0) localAttempts += clickedTextCount;
            const textRedirect = textResults.some(r => r.navigated || r.popupOpened);
            if (textRedirect) localRedirect = true;
            const textGclid = textResults.some(r => r.gclid);
            if (textGclid) {
              return { attempted: localAttempts, gclid: true, via: `${label}|text`, clickedWithoutGclid, clickAttemptFailed };
            }
            if (textResults.some(r => !r.clicked)) {
              clickAttemptFailed = true;
              if (!textRedirect && !gotGclid) clickedWithoutGclid = true;
              return { attempted: localAttempts, gclid: gotGclid, via: `${label}|text`, clickedWithoutGclid, clickAttemptFailed };
            }
            if (!textRedirect && !gotGclid && clickedTextCount > 0) {
              clickedWithoutGclid = true;
              clickAttemptFailed = true;
              return { attempted: localAttempts, gclid: gotGclid, via: `${label}|text`, clickedWithoutGclid, clickAttemptFailed };
            }
          }

          for (let i = 0; i < maxRapidClicks; i += 1) {
            const fraction = fractions[i % fractions.length];
            const result = await clickBoundingBox(preferred, `${label}#${i + 1}`, (box) => {
              const jitterX = randInt(-Math.max(6, Math.floor(box.width * 0.06)), Math.max(6, Math.floor(box.width * 0.06)));
              const offsetY = randInt(3, Math.max(6, Math.min(20, Math.floor(box.height * 0.25) || 0)));
              const targetX = box.width * fraction + jitterX;
              const targetY = box.height - offsetY;
              return {
                x: Math.max(2, Math.min(box.width - 2, targetX)),
                y: Math.max(2, Math.min(box.height - 2, targetY))
              };
            }, {
              timeout: Math.min(AD_FRAME_WAIT, 1600),
              waitAfter: 110,
              postClickWait: 220,
              minDelay: 35,
              maxDelay: 75
            });
            rapidResults.push(result);
            if (!result.clicked) {
              clickAttemptFailed = true;
              return { attempted: localAttempts + i, gclid: gotGclid, clickedWithoutGclid, clickAttemptFailed: true };
            }
            if (result.gclid || gotGclid) {
              return { attempted: localAttempts + i + 1, gclid: true, via: label, clickedWithoutGclid, clickAttemptFailed };
            }
            if (gotGclid) {
              return { attempted: localAttempts + i + 1, gclid: true, via: label, clickedWithoutGclid, clickAttemptFailed };
            }
          }
          const anyRedirect = localRedirect || rapidResults.some(r => r && (r.navigated || r.popupOpened));
          if (!gotGclid && !anyRedirect) {
            clickedWithoutGclid = true;
            clickAttemptFailed = true;
          }
          const clickedCount = rapidResults.filter(r => r && r.clicked).length;
          const totalAttempts = localAttempts + clickedCount;
          return { attempted: totalAttempts, gclid: gotGclid, via: label, clickedWithoutGclid, clickAttemptFailed };
        }

        return { attempted: 0, gclid: false, clickedWithoutGclid, clickAttemptFailed };
      }

      const bottomResult = await clickBottomBanner();
      attempts += bottomResult.attempted;
      if (bottomResult.clickAttemptFailed) clickAttemptFailed = true;
      if (bottomResult.gclid || gotGclid) {
        return {
          attempted: attempts,
          gclid: true,
          via: bottomResult.via || 'bottom-anchor',
          clickedWithoutGclid,
          clickAttemptFailed
        };
      }
      const primarySelectors = [
        'iframe[id*="aswift"], iframe[name*="aswift"], iframe[src*="googleads"], iframe[id*="google_ads"]',
        'div[id^="aswift_"][id$="_host"], div[id^="google_ads_iframe_"], div[id^="google_ads_frame"], div[id^="dfp-ad"], div[class*="adsbygoogle"], div[data-ad-client]',
        'ins.adsbygoogle, ins[data-ad-status], ins[class*="adsbygoogle"], ins[id*="google"], ins.adsbygoogle-noablate',
        '.adsbygoogle iframe, .adsbygoogle-container iframe',
        'a[data-test="banner"], .banner a, a[href*="googleads"]'
      ];

      for (const selector of primarySelectors) {
        const handles = await page.$$(selector);
        for (const handle of handles) {
          if (await finishIfGclid() || aborted) {
            return { attempted: attempts, gclid: true, clickedWithoutGclid, clickAttemptFailed };
          }
          const preferred = await preferIframeHandle(handle);
          if (!preferred) continue;
          await preferred.evaluate((el) => {
            if (el && typeof el.removeAttribute === 'function' && el.getAttribute('target') === '_blank') {
              el.removeAttribute('target');
            }
          }).catch(()=>{});
          const result = await clickBoundingBox(preferred, `selector:${selector}`);
          if (result.clicked) {
            attempts += 1;
            if (result.gclid || gotGclid) {
              return { attempted: attempts, gclid: true, via: selector, clickedWithoutGclid, clickAttemptFailed };
            }
            const hadRedirect = !!(result.navigated || result.popupOpened);
            if (!result.gclid && !gotGclid && !hadRedirect) clickedWithoutGclid = true;
          } else {
            clickAttemptFailed = true;
            return { attempted: attempts, gclid: gotGclid, clickedWithoutGclid, clickAttemptFailed: true };
          }
        }
      }

      const allFrames = collectFrames(page.mainFrame());

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
        if (await finishIfGclid() || aborted) {
          return { attempted: attempts, gclid: true, clickedWithoutGclid, clickAttemptFailed };
        }
        try {
          await page.waitForTimeout(randInt(AD_WAIT_MIN, AD_WAIT_MAX)).catch(()=>{});
          const clickable = await frame.$('a, button, [role="button"], [role="link"], iframe');
          let result = { clicked: false, gclid: false };
          if (clickable) {
            let navigated = false;
            let popupOpened = false;
            const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: AD_FRAME_WAIT })
              .then(() => { navigated = true; return true; })
              .catch(()=>null);
            const popupPromise = page.waitForEvent('popup', { timeout: AD_FRAME_WAIT })
              .then(() => { popupOpened = true; return true; })
              .catch(()=>null);
            await clickable.click({ delay: 150 }).catch(()=>{});
            await Promise.race([
              navPromise,
              popupPromise,
              page.waitForTimeout(randInt(AD_WAIT_MIN, AD_WAIT_MAX)).catch(()=>null)
            ]).catch(()=>null);
            await logLine(`${prefix} blank_frame_click`);
            const captured = await waitForGclid(AD_FRAME_WAIT + POST_CLICK_WAIT);
            result = { clicked: true, gclid: captured, navigated, popupOpened };
          } else {
            const frameEl = await frame.frameElement().catch(()=>null);
            if (frameEl) {
              result = await clickBoundingBox(frameEl, 'blank-frame');
            } else {
              result = await clickFrame(frame, 'about:blank');
            }
          }
          if (result.clicked) {
            attempts += 1;
            if (result.gclid || gotGclid) {
              return { attempted: attempts, gclid: true, via: 'blank-frame', clickedWithoutGclid, clickAttemptFailed };
            }
            const hadRedirect = !!(result.navigated || result.popupOpened);
            if (!result.gclid && !gotGclid && !hadRedirect) clickedWithoutGclid = true;
          } else {
            clickAttemptFailed = true;
            return { attempted: attempts, gclid: gotGclid, clickedWithoutGclid, clickAttemptFailed: true };
          }
        } catch (err) {
          if (await handleContextClosed(err, 'BLANK_FRAME')) break;
          await abortWithError(`BLANK_FRAME_CLICK_ERROR ${err.message}`);
          break;
        }
      }

      const frames = allFrames.filter(f => {
        const url = f.url() || '';
        return /googleads\.g\.doubleclick\.net|aswift_|adsystem|doubleclick|pagead\//i.test(url);
      });
      for (const frame of frames) {
        if (await finishIfGclid() || aborted) {
          return { attempted: attempts, gclid: true, clickedWithoutGclid, clickAttemptFailed };
        }
        const result = await clickFrame(frame, frame.url() || 'frame');
        if (result.clicked) {
          attempts += 1;
          if (result.gclid || gotGclid) {
            return { attempted: attempts, gclid: true, via: 'frame', clickedWithoutGclid, clickAttemptFailed };
          }
          const hadRedirect = !!(result.navigated || result.popupOpened);
          if (!result.gclid && !gotGclid && !hadRedirect) clickedWithoutGclid = true;
        } else {
          clickAttemptFailed = true;
          return { attempted: attempts, gclid: gotGclid, clickedWithoutGclid, clickAttemptFailed: true };
        }
      }

      return { attempted: attempts, gclid: gotGclid, clickedWithoutGclid, clickAttemptFailed };
    }

    const clickOutcome = await clickFirstBanner();
    if (clickOutcome.attempted === 0 && !gotGclid) {
      if (!aborted) await abortWithError('BANNER_CLICK_FAILED');
      return;
    }

    if (clickOutcome.clickAttemptFailed) {
      if (!aborted) await abortWithError('BANNER_CLICK_ATTEMPT_FAILED');
      return;
    }

    if (clickOutcome.clickedWithoutGclid) {
      if (!aborted) await abortWithError('BANNER_CLICK_NO_REDIRECT_GCLID');
      return;
    }

    if (!clickOutcome.gclid && clickOutcome.attempted > 0) {
      if (!aborted) await abortWithError('BANNER_CLICK_NO_GCLID');
      return;
    }

    if (await finishIfGclid() || aborted) return;

    const dwell = randInt(LAND_MIN, LAND_MAX);
    await page.waitForTimeout(dwell);

    if (await finishIfGclid() || aborted) return;

    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch {}
    if (currentUrl) {
      await markGclid('page-final', currentUrl);
    }

    if (!(await finishIfGclid())) {
      await logLine(`${prefix} click_done_no_gclid page=${currentUrl}`);
      try {
        await page.close({ runBeforeUnload: false });
      } catch {}
    }

    return;
  } catch (err) {
    if (!(await handleContextClosed(err, 'RUN'))) {
      await abortWithError(`ERROR ${err.message}`);
    }
  } finally {
    try { if (browser) await browser.close(); } catch {}
    if (!gotGclid && !aborted) {
      await logLine(`${prefix} RESTART`);
    }
  }
}

let STOP = false;
process.on('SIGINT', () => { console.log('SIGINT -> stopping after current batch'); STOP = true; });

async function main() {
  let proxies = await loadLines(PROXIES_FILE);
  proxies = sortProxiesByPort(proxies);
  if (proxies.length === 0) {
    proxies = generateProxiesFromEnv();
    if (proxies.length > 0) {
      console.log(`Generated ${proxies.length} proxies from env configuration.`);
    }
    proxies = sortProxiesByPort(proxies);
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
  const batchSize = Math.max(1, POOL_SIZE);

  // Ejecutar indefinidamente hasta SIGINT, procesando navegadores de forma estrictamente secuencial
  while (!STOP) {
    for (let i = 0; i < batchSize && !STOP; i++) {
      const proxy = proxies[counter % proxies.length];
      const ua = sample(uas);
      counter += 1;
      const runIndex = counter;
      try {
        await runOne(proxy, ua, runIndex);
      } catch (err) {
        await logLine(`[runner] #${runIndex} runOne_error ${err.message || err}`);
      }
    }
  }
}

main().catch(err => {
  console.error('fatal', err);
  process.exit(1);
});