/**
 * Production HTTP server wrapper for TanStack Start.
 * dist/server/server.js exports a Web Fetch API handler — never binds a port.
 * This bridges it to Node.js http.createServer.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env.docker before any other modules (must happen before the dynamic import)
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const envPath = join(__dirname, '.env.docker');
try {
  const envContent = await import('node:fs').then(fs => fs.readFileSync(envPath, 'utf8'));
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = val;
    }
  }
} catch {
  // .env.docker not found — rely on injected env vars
}

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_ORIGIN = new URL(process.env.APP_URL ?? `http://localhost:${PORT}`);

function securityHeaders() {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; upgrade-insecure-requests",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (process.env.NODE_ENV === 'production' && PUBLIC_ORIGIN.protocol === 'https:') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

console.error('[server] Starting with env:', {
  PORT, HOST,
  DATABASE_URL: process.env.DATABASE_URL ? '[SET]' : '[MISSING]',
  NODE_ENV: process.env.NODE_ENV,
  AUTH_SECRET: process.env.AUTH_SECRET ? '[SET]' : '[MISSING]',
  APP_URL: process.env.APP_URL,
  VITE_APP_URL: process.env.VITE_APP_URL,
});

const CLIENT_DIR = resolve(__dirname, 'dist/client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

function tryServeStatic(pathname, res) {
  const safePath = pathname.replace(/\.\./g, '');
  const filePath = join(CLIENT_DIR, safePath);
  if (!filePath.startsWith(CLIENT_DIR)) return false;
  let stat;
  try { stat = statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  // Only content-hashed filenames (e.g. index-BmSZZem9.js) are safe to cache
  // immutably. Stable, unhashed names (e.g. globals.css — see vite.config.ts)
  // must NOT be immutable, or a redeploy that changes them would be ignored.
  const isHashedAsset = /\/assets\/.*-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/i.test(safePath);
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

const { default: app } = await import('./dist/server/server.js');
if (!app || typeof app.fetch !== 'function') {
  console.error('ERROR: dist/server/server.js did not export a valid fetch handler');
  process.exit(1);
}
console.error('[server] App handler loaded OK');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', PUBLIC_ORIGIN);

  // Paths may contain invitation/reset/export identifiers; do not log them.
  console.error('[server] Incoming request:', req.method);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (tryServeStatic(url.pathname, res)) {
      console.error('[server] Served static asset');
      return;
    }
  }

  const hasCookie = typeof req.headers.cookie === 'string' && req.headers.cookie.length > 0;
  const unsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
  if (hasCookie && unsafeMethod) {
    const origin = req.headers.origin;
    let trusted;
    try { trusted = typeof origin === 'string' && new URL(origin).origin === PUBLIC_ORIGIN.origin; } catch { trusted = false; }
    if (!trusted) {
      res.writeHead(403, { ...securityHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 403, message: 'Forbidden' }));
      return;
    }
  }

  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else headers.set(key, val);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const webRequest = new Request(url.href, {
    method: req.method,
    headers,
    ...(hasBody ? { body: req, duplex: 'half' } : {}),
  });

  let webResponse;
  try {
    webResponse = await app.fetch(webRequest);
  } catch (err) {
    console.error('[server] Handler error:', err instanceof Error ? err.name : 'UnknownError');
    res.writeHead(500, { ...securityHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 500, message: 'Internal server error' }));
    return;
  }

  const resHeaders = {};
  for (const [k, v] of webResponse.headers.entries()) {
    resHeaders[k] = v;
  }
  Object.assign(resHeaders, securityHeaders());
  res.writeHead(webResponse.status, resHeaders);

  if (webResponse.body) {
    const reader = webResponse.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
});

server.listen(PORT, HOST, () => console.error(`[server] Listening on http://${HOST}:${PORT}`));
server.on('error', (err) => {
  console.error('[server] Fatal:', err);
  process.exit(1);
});
