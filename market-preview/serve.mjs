#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SKILLOPS_PREVIEW_PORT || 4173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('SKILLOPS_PREVIEW_PORT must be an integer between 1 and 65535');
const TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(ROOT, `.${decodeURIComponent(requested)}`);
  if (!resolved.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES.get(path.extname(resolved)) || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(resolved).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`SkillOps market preview: http://127.0.0.1:${PORT}\n`);
});
