// tsc only emits .js — the SQL migrations have to be copied into dist by hand.
const fs = require('node:fs');
const path = require('node:path');

const pairs = [['src/db/migrations', 'dist/db/migrations']];

for (const [from, to] of pairs) {
  const src = path.join(__dirname, '..', from);
  const dest = path.join(__dirname, '..', to);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
  console.log(`copied ${from} -> ${to}`);
}
