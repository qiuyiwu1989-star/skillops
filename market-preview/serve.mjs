#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

function requestedFile(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl || '/', 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const initial = path.resolve(root, `.${requested}`);
  if (initial !== root && !initial.startsWith(`${root}${path.sep}`)) return null;
  if (!fs.existsSync(initial)) return null;
  const stat = fs.statSync(initial);
  const resolved = stat.isDirectory() ? path.join(initial, 'index.html') : initial;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  const realRoot = fs.realpathSync(root);
  const realResolved = fs.realpathSync(resolved);
  if (realResolved !== realRoot && !realResolved.startsWith(`${realRoot}${path.sep}`)) return null;
  return realResolved;
}

export function createPreviewServer({ root = process.env.SKILLOPS_PREVIEW_ROOT || HERE } = {}) {
  const resolvedRoot = path.resolve(root);
  return http.createServer((request, response) => {
    const resolved = requestedFile(resolvedRoot, request.url);
    if (!resolved) {
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
}

function main() {
  const port = Number(process.env.SKILLOPS_PREVIEW_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SKILLOPS_PREVIEW_PORT must be an integer between 1 and 65535');
  const server = createPreviewServer();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`SkillOps market preview: http://127.0.0.1:${port}\n`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
