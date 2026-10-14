import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');

rmSync(output, { recursive: true, force: true });
mkdirSync(output);

for (const name of ['index.html', 'style.css', 'script.js']) {
  copyFileSync(join(root, name), join(output, name));
}

if (existsSync(join(root, 'assets'))) {
  cpSync(join(root, 'assets'), join(output, 'assets'), { recursive: true });
}

if (existsSync(join(root, 'projects'))) {
  cpSync(join(root, 'projects'), join(output, 'projects'), { recursive: true });
}

console.log('Built site in dist/');
