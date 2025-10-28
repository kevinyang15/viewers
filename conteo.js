import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const logPath = process.argv[2] || path.resolve(__dirname, 'gclids.log');

  let content;
  try {
    content = await fs.readFile(logPath, 'utf8');
  } catch (err) {
    console.error(`No pude leer ${logPath}:`, err.message);
    process.exit(1);
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  const regex = /\b(gclid=[^\s]+)/i;
  const counts = new Map();
  const perDay = new Map();

  for (const line of lines) {
    const match = line.match(regex);
    if (!match) continue;

    const gclidValue = match[1].split('=')[1];
    counts.set(gclidValue, (counts.get(gclidValue) || 0) + 1);

    const timestamp = line.split(' ')[0];
    const day = timestamp?.slice(0, 10) || 'desconocido';
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }

  console.log(`Total de gclid únicos: ${counts.size}`);
  let total = 0;
  for (const [gclid, count] of counts.entries()) {
    console.log(`${gclid} -> ${count}`);
    total += count;
  }
  console.log(`Total de ocurrencias (líneas con gclid): ${total}`);

  console.log('\nTotales por día:');
  const days = Array.from(perDay.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [day, count] of days) {
    console.log(`${day}: ${count}`);
  }
}

main();
