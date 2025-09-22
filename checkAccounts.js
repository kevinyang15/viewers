import { chromium } from 'playwright';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const TARGET_URL  = process.env.TARGET_URL || 'https://x.com/home';
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || '45000', 10);
const HEADLESS    = (process.env.HEADLESS || '0') === '1';
const VIEWPORT    = process.env.VIEWPORT || '1280x720';
const BLOCK_HEAVY = (process.env.BLOCK_HEAVY || '0') === '1';
const UA          = process.env.USER_AGENT || null;
const ACC_LIMIT   = parseInt(process.env.ACC_LIMIT || '0', 10);
const STAGGER_MS  = parseInt(process.env.STAGGER_MS || '1500', 10);

const [vw, vh] = VIEWPORT.split('x').map(n => parseInt(n, 10) || 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const ACCOUNTS_PATH = path.resolve(SCRIPT_DIR, 'accounts.json');
const ERR_OUT_PATH  = path.resolve(SCRIPT_DIR, 'accountsErrors.json');

async function readAccounts() {
  let raw = '';
  try {
    raw = await fs.readFile(ACCOUNTS_PATH, 'utf-8');
  } catch (e) {
    console.error(`❌ No pude leer accounts.json en ${ACCOUNTS_PATH}: ${e.message}`);
    process.exit(1);
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ Error parseando accounts.json: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    console.error('❌ accounts.json vacío o inválido.');
    process.exit(1);
  }
  if (ACC_LIMIT > 0) arr = arr.slice(0, ACC_LIMIT);
  return arr;
}

function proxyFromString(str) {
  if (!str) return undefined;
  try {
    const u = new URL(str);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || '')
    };
  } catch {
    return undefined;
  }
}

async function checkOne(browser, acc, idx) {
  const name = acc.username || `acct_${idx + 1}`;
  const logPrefix = `[${String(idx + 1).padStart(3, '0')} ${name}]`;

  const proxy = proxyFromString(acc.proxy);
  const context = await browser.newContext({
    proxy,
    viewport: vw && vh ? { width: vw, height: vh } : undefined,
    userAgent: UA || undefined,
    locale: 'en-US',
    deviceScaleFactor: 1
  });

  try {
    const token = (acc.auth_token || '').trim();
    if (!token || token.length < 10) {
      console.warn(`${logPrefix} token inválido`);
      await context.close().catch(() => {});
      return { connected: false, reason: 'invalid_token' };
    }

    await context.addCookies([
      { name: 'auth_token', value: token, domain: '.x.com',       path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'auth_token', value: token, domain: '.twitter.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }
    ]);

    const page = await context.newPage();

    if (BLOCK_HEAVY) {
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'font' || t === 'stylesheet' || t === 'media') return route.abort();
        return route.continue();
      });
    }

    process.stdout.write(`${logPrefix} goto ${TARGET_URL}\n`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Esperar a que la app termine la mayor parte de las cargas de red.
    // X puede mantener conexiones abiertas, así que limitamos el timeout.
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {}

    let connected = false;
    let reason = '';

    const successSelectors = [
      '[data-testid="AppTabBar_Home_Link"]',
      '[data-testid="SideNav_AccountSwitcher_Button"]',
      '[aria-label="Top navigation bar"]',
      '[aria-label="Timeline: Your Home Timeline"]'
    ];
    const loginSelectors = [
      'form[action*="/i/flow/login"]',
      'a[href="/i/flow/login"]',
      '[data-testid="login"], [data-testid="LoginForm_Login_Button"]',
      'input[name="text"]'
    ];

    const winner = await Promise.race([
      page.waitForSelector(successSelectors.join(', '), { timeout: 20000 }).then(() => 'success').catch(() => ''),
      page.waitForSelector(loginSelectors.join(', '), { timeout: 20000 }).then(() => 'login').catch(() => ''),
      page.waitForURL(/(login|flow|challenge|signup|account)/i, { timeout: 20000 }).then(() => 'login').catch(() => '')
    ]);

    if (winner === 'success') {
      connected = true;
    } else if (winner === 'login') {
      connected = false;
      reason = 'redirect_to_login';
    } else {
      const url = page.url();
      if (/(login|flow|challenge|signup|account)/i.test(url)) {
        reason = 'redirect_to_login';
      } else {
        const bodyText = (await page.textContent('body').catch(() => '')) || '';
        if (/(Log in|Sign in|Inicia sesión|Crear cuenta|Create account)/i.test(bodyText)) {
          reason = 'login_ui';
        } else {
          reason = 'unknown';
        }
      }
    }

    process.stdout.write(`${logPrefix} ${connected ? '✅ login OK' : `❌ login FAIL (${reason})`}\n`);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    return { connected, reason };
  } catch (e) {
    console.error(`${logPrefix} ❌ error: ${e.message || e}`);
    await context.close().catch(() => {});
    return { connected: false, reason: 'exception' };
  }
}

(async () => {
  const accounts = await readAccounts();

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const failed = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const res = await checkOne(browser, acc, i);
    if (!res.connected) {
      failed.push({
        username: acc.username || `acct_${i + 1}`,
        auth_token: acc.auth_token,
        reason: res.reason
      });
    }
    if (STAGGER_MS) await sleep(STAGGER_MS);
  }

  await browser.close().catch(() => {});

  await fs.writeFile(ERR_OUT_PATH, JSON.stringify(failed, null, 2));
  console.log(`📝 Guardado ${failed.length} errores en ${ERR_OUT_PATH}`);
})();


