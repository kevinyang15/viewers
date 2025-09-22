// run.js
// Node 18+ / Playwright
import { chromium, devices } from 'playwright';
import pLimit from 'p-limit';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);
const TARGET_URL  = process.env.TARGET_URL || 'https://x.com/home';
const SESSION_MIN = parseInt(process.env.SESSION_MIN || '15', 10);
const BLOCK_HEAVY = (process.env.BLOCK_HEAVY || '1') === '1'; // 1 = bloquear imágenes, fonts, css
const HEADLESS    = (process.env.HEADLESS || '1') === '1';    // 1 = headless
const VIEWPORT    = process.env.VIEWPORT || '1280x720';       // ej "1920x1080"
const STAGGER_MS  = parseInt(process.env.STAGGER_MS || '1500', 10); // delay entre lanzamientos
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || '45000', 10); // 45s
const UA          = process.env.USER_AGENT || null; // si querés setear un UA propio

const [vw, vh] = VIEWPORT.split('x').map(n => parseInt(n, 10) || 0);
// Carga robusta de accounts.json con mensajes claros
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const ACCOUNTS_PATH = path.resolve(SCRIPT_DIR, 'accounts.json');
let rawJson = '';
try {
  rawJson = await fs.readFile(ACCOUNTS_PATH, 'utf-8');
} catch (e) {
  console.error(`❌ No pude leer accounts.json en ${ACCOUNTS_PATH}: ${e.message}`);
  console.error('👉 Asegurate de que el archivo exista y tenga permisos de lectura.');
  process.exit(1);
}
if (!rawJson || rawJson.trim().length === 0) {
  console.error(`❌ accounts.json está vacío en ${ACCOUNTS_PATH}`);
  console.error('👉 Rellenalo con tus cuentas o genera uno correcto.');
  process.exit(1);
}
let accounts;
try {
  accounts = JSON.parse(rawJson);
} catch (e) {
  console.error('❌ Error parseando accounts.json: ' + e.message);
  console.error('👉 Tip: validá el JSON con `jq . accounts.json` o https://jsonlint.com');
  process.exit(1);
}
const ACC_LIMIT = parseInt(process.env.ACC_LIMIT || '0', 10); // limita cantidad para pruebas locales
if (ACC_LIMIT > 0) accounts = accounts.slice(0, ACC_LIMIT);

if (!Array.isArray(accounts) || accounts.length === 0) {
  console.error('❌ accounts.json vacío o inválido.');
  process.exit(1);
}

const logsDir = path.resolve('./logs');
await fs.mkdir(logsDir, { recursive: true });

const STATES_DIR = process.env.STATES_DIR || './states';
const PERSIST = (process.env.PERSIST || '1') === '1'; // guarda cookies/session por cuenta
await fs.mkdir(STATES_DIR, { recursive: true });

const POOL_SIZE = parseInt(process.env.POOL_SIZE || process.env.CONCURRENCY || '5', 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: HEADLESS,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-blink-features=AutomationControlled'
  ]
});

// === Rotación continua ===
let STOP = false;
process.on('SIGINT', () => {
  console.log('\n🛑 Recibido SIGINT, cerrando cuando terminen las sesiones en curso...');
  STOP = true;
});

let nextIndex = 0; // índice global para repartir cuentas

async function worker(workerId){
  while(!STOP){
    const idx = nextIndex++;
    const realIdx = idx % accounts.length;
    const acc = accounts[realIdx];
    try {
      await runOne(acc, realIdx);
    } catch (e) {
      console.error(`[worker ${workerId}] error:`, e.message || e);
    }
    if (STAGGER_MS) await sleep(STAGGER_MS); // pequeño respiro entre sesiones
  }
}

async function runOne(acc, idx) {
  const name = acc.username || `acct_${idx + 1}`;
  const logPrefix = `[${String(idx + 1).padStart(3, '0')} ${name}]`;

  // proxy por cuenta (si se definió en accounts.json) + storageState persistente
  const statePath = path.resolve(STATES_DIR, `${name}.json`);
  
  let proxyOpts;
  if (acc.proxy) {
    try {
      const px = new URL(acc.proxy);
      proxyOpts = {
        server: `${px.protocol}//${px.hostname}:${px.port}`,
        username: decodeURIComponent(px.username),
        password: decodeURIComponent(px.password),
      };
    } catch (e) {
      console.error(`${logPrefix} proxy inválido: ${acc.proxy}`);
    }
  }

  const commonOpts = {
    proxy: proxyOpts,
    viewport: vw && vh ? { width: vw, height: vh } : undefined,
    userAgent: UA || undefined,
    locale: 'en-US',
    deviceScaleFactor: 1,
  };

  let context;
  if (fsSync.existsSync(statePath)) {
    // si ya existe estado guardado, cargarlo para reusar cookies/sesión
    context = await browser.newContext({ ...commonOpts, storageState: statePath });
  } else {
    context = await browser.newContext(commonOpts);
  }

  // Inyectar cookie auth_token para x.com y twitter.com
  if (!acc.auth_token || typeof acc.auth_token !== 'string' || acc.auth_token.length < 10) {
    console.warn(`${logPrefix} token inválido, skip`);
    await context.close();
    return;
  }

  // Solo inyectar cookies si aún no teníamos storageState
  if (!fsSync.existsSync(statePath)) {
    await context.addCookies([
      {
        name: 'auth_token',
        value: acc.auth_token.trim(),
        domain: '.x.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: 'auth_token',
        value: acc.auth_token.trim(),
        domain: '.twitter.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      }
    ]);
  }

  const page = await context.newPage();

  // Bloquear recursos pesados para ahorrar ancho de banda/CPU
  if (BLOCK_HEAVY) {
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'stylesheet' || t === 'media') {
        return route.abort();
      }
      return route.continue();
    });
  }

  // Logs simples por cuenta
  const logfile = path.join(logsDir, `${name}.log`);
  const log = async (msg) => {
    const line = `${new Date().toISOString()} ${logPrefix} ${msg}\n`;
    process.stdout.write(line);
    await fs.appendFile(logfile, line).catch(() => {});
  };

  try {
    await log(`goto ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Verificación muy básica de sesión (existe cookie de guest_id y auth_token?)
    const cookies = await context.cookies();
    const hasAuth = cookies.some(c => c.name === 'auth_token' && c.value);
    if (!hasAuth) {
      await log('⚠️ auth_token no aplicado correctamente');
    }

    const until = Date.now() + SESSION_MIN * 60_000;

    // Pequeña actividad periódica para “simular vida”
    while (Date.now() < until) {
      // scrolleo leve y no determinista
      try {
        await page.evaluate(() => {
          const y = 200 + Math.floor(Math.random() * 400);
          window.scrollBy({ top: y, behavior: 'smooth' });
        });
      } catch {}

      // pequeñas esperas aleatorias (20–35s)
      await sleep(20_000 + Math.floor(Math.random() * 15_000));
    }

    await log('✅ sesión completa');
  } catch (e) {
    await log(`❌ error: ${e.message || e}`);
  } finally {
    try {
      if (PERSIST) {
        await context.storageState({ path: statePath });
      }
    } catch {}
    await context.close();
  }
}

// Inicia un pool fijo de workers que van rotando por todas las cuentas
await Promise.all(Array.from({ length: POOL_SIZE }, (_, i) => worker(i+1)));

await browser.close();
console.log('🏁 Fin (rotación detenida).');