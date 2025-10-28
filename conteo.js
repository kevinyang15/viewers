const fs = require('fs/promises');
const path = require('path');

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
      const gclidEntry = match[1].split('=')[1];
      const current = counts.get(gclidEntry) || 0;
      counts.set(gclidEntry, current + 1);
    }
  }

  console.log(`Total de líneas con gclid: ${counts.size}`);
  for (const [gclid, count] of counts.entries()) {
    console.log(`${gclid} -> ${count}`);
  }
}

main();
