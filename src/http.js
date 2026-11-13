'use strict';
// Minimal HTTP framework: routing, JSON bodies, cookies, static files, file downloads.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
};
const MAX_BODY = 4 * 1024 * 1024;
const COOKIE = 'pw_session';

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

function createRouter() {
  const routes = [];
  const route = (method, pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handlers });
  };
  return { routes, route };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'That upload is too large (limit 4 MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'The request was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }).end(data);
  });
}

const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

// getUser(token) -> user | null
function createServer({ routes, getUser }) {
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveStatic(res, url.pathname);
    }
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const cookies = [];
    try {
      const match = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!match) fail(404, 'Not found.');
      // CSRF defence: state-changing requests must be JSON (a browser can't send that cross-site without CORS).
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) fail(415, 'Requests must be sent as JSON.');
      const m = url.pathname.match(match.re);
      const token = parseCookies(req.headers.cookie)[COOKIE] || null;
      const ctx = {
        params: Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
        query: url.searchParams,
        body: req.method === 'GET' ? null : await readBody(req),
        token,
        user: getUser(token),
        setCookie: v => cookies.push(`${COOKIE}=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${v ? 43200 : 0}${process.env.VERCEL ? '; Secure' : ''}`),
      };
      let out;
      for (const h of match.handlers) out = await h(ctx);
      if (cookies.length) headers['set-cookie'] = cookies;
      if (out && out.__file) {
        res.writeHead(200, { ...headers, 'content-type': out.__file.type, 'content-disposition': `attachment; filename="${out.__file.name.replace(/[^\w.\-]/g, '_')}"` });
        res.end('﻿' + out.__file.body); // BOM so Excel reads UTF-8 names correctly
        return;
      }
      res.writeHead(200, headers).end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res.writeHead(status, headers).end(JSON.stringify({
        error: status === 500 ? 'Something went wrong on our side. Your progress is saved — please try again in a moment.' : e.message, ...(e.extra || {}),
      }));
    }
  }
  return http.createServer((req, res) => { handle(req, res); });
}

module.exports = { createRouter, createServer, HttpError, fail };
