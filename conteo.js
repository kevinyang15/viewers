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

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const gclidValue = match[1].split('=')[1];
      counts.set(gclidValue, (counts.get(gclidValue) || 0) + 1);
    }
  }

  console.log(`Total de gclid únicos: ${counts.size}`);
  for (const [gclid, count] of counts.entries()) {
    console.log(`${gclid} -> ${count}`);
  }
}

main();
