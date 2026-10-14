import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const host = '127.0.0.1';
const startPort = Number(process.env.PORT) || 5173;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const publicPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  if (!['/index.html', '/style.css', '/script.js'].includes(publicPath)
      && !publicPath.startsWith('/assets/')
      && !publicPath.startsWith('/projects/')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  const file = resolve(root, `.${publicPath}`);
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    if (!statSync(file).isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

let port = startPort;

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < startPort + 20) {
    server.listen(++port, host);
  } else {
    console.error(error);
    process.exitCode = 1;
  }
});

server.on('listening', () => {
  console.log(`\n  Hyunjoo's Home Page is ready!`);
  console.log(`  Local: http://localhost:${server.address().port}/\n`);
});

server.listen(port, host);
