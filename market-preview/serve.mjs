#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPreviewAcquisitionService, PreviewAcquisitionError } from './preview-acquisition.mjs';
import { createPreviewWorkbenchService, PreviewWorkbenchError } from './preview-workbench.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_JSON_BODY_BYTES = 16 * 1024;
const ACQUISITION_CATALOG_PATH = '/api/v1/preview/acquisitions';
const FREE_ACQUISITION_PATH = '/api/v1/preview/acquisitions/free';
const TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
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

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new PreviewAcquisitionError('JSON_REQUIRED', '请求必须使用 application/json', 415);
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    throw new PreviewAcquisitionError('REQUEST_TOO_LARGE', '请求体超过 16 KiB 限制', 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON_BODY_BYTES) {
      throw new PreviewAcquisitionError('REQUEST_TOO_LARGE', '请求体超过 16 KiB 限制', 413);
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch (cause) {
    throw new PreviewAcquisitionError('INVALID_JSON', '请求体不是有效的 JSON 对象', 400, cause);
  }
}

async function handleAcquisitionApi(request, response, acquisitionService) {
  let pathname;
  try { pathname = new URL(request.url || '/', 'http://localhost').pathname; } catch { return false; }
  if (pathname !== ACQUISITION_CATALOG_PATH && pathname !== FREE_ACQUISITION_PATH) return false;
  if (!acquisitionService) {
    writeJson(response, 503, { ok: false, error: { code: 'LOCAL_SERVICE_DISABLED', messageZh: '本地获取服务未启用' } });
    return true;
  }
  try {
    if (pathname === ACQUISITION_CATALOG_PATH && request.method === 'GET') {
      writeJson(response, 200, { ok: true, data: acquisitionService.catalog() });
      return true;
    }
    if (pathname === FREE_ACQUISITION_PATH && request.method === 'POST') {
      const input = await readJsonBody(request);
      writeJson(response, 200, { ok: true, data: acquisitionService.acquire(input) });
      return true;
    }
    writeJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', messageZh: '该接口不支持当前请求方法' } });
    return true;
  } catch (cause) {
    const statusCode = cause instanceof PreviewAcquisitionError ? cause.statusCode : 500;
    const code = cause instanceof PreviewAcquisitionError ? cause.code : 'PREVIEW_SERVICE_FAILED';
    const messageZh = cause instanceof PreviewAcquisitionError ? cause.messageZh : '本地获取服务暂时不可用';
    writeJson(response, statusCode, { ok: false, error: { code, messageZh } });
    return true;
  }
}

async function handleWorkbenchApi(request, response, workbenchService) {
  let pathname;
  try { pathname = new URL(request.url || '/', 'http://localhost').pathname; } catch { return false; }
  const match = pathname.match(/^\/api\/v1\/preview\/workbench\/handoffs(?:\/(wbh_[a-f0-9]{64}))?$/);
  if (!match) return false;
  if (!workbenchService) {
    writeJson(response, 503, { ok: false, error: { code: 'LOCAL_SERVICE_DISABLED', messageZh: '本地工作台服务未启用' } });
    return true;
  }
  try {
    if (request.method === 'POST' && !match[1]) {
      writeJson(response, 201, { ok: true, data: workbenchService.create(await readJsonBody(request)) });
      return true;
    }
    if (request.method === 'GET' && match[1]) {
      writeJson(response, 200, { ok: true, data: workbenchService.get(match[1]) });
      return true;
    }
    writeJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', messageZh: '该接口不支持当前请求方法' } });
    return true;
  } catch (cause) {
    const statusCode = cause instanceof PreviewWorkbenchError ? cause.statusCode : 500;
    const code = cause instanceof PreviewWorkbenchError ? cause.code : 'WORKBENCH_SERVICE_FAILED';
    const messageZh = cause instanceof PreviewWorkbenchError ? cause.messageZh : '本地工作台服务暂时不可用';
    writeJson(response, statusCode, { ok: false, error: { code, messageZh } });
    return true;
  }
}

export function createPreviewServer({ root = process.env.SKILLOPS_PREVIEW_ROOT || HERE, acquisitionService = null, workbenchService = null } = {}) {
  const resolvedRoot = path.resolve(root);
  return http.createServer(async (request, response) => {
    if (await handleAcquisitionApi(request, response, acquisitionService)) return;
    if (await handleWorkbenchApi(request, response, workbenchService)) return;
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed');
      return;
    }
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
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(resolved).pipe(response);
  });
}

function main() {
  const port = Number(process.env.SKILLOPS_PREVIEW_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SKILLOPS_PREVIEW_PORT must be an integer between 1 and 65535');
  const ledgerPath = process.env.SKILLOPS_PREVIEW_ACQUISITION_LEDGER
    || path.join(os.tmpdir(), 'skillops-market-preview-acquisitions.json');
  const acquisitionService = createPreviewAcquisitionService({ ledgerPath });
  const workbenchLedgerPath = process.env.SKILLOPS_PREVIEW_WORKBENCH_LEDGER
    || path.join(os.tmpdir(), 'skillops-market-preview-workbench.json');
  const workbenchService = createPreviewWorkbenchService({
    listingsPath: path.join(HERE, 'data', 'listings.json'),
    ledgerPath: workbenchLedgerPath,
  });
  const server = createPreviewServer({ acquisitionService, workbenchService });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`SkillOps market preview: http://127.0.0.1:${port}\n`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
