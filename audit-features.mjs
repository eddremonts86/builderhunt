import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const results = [];

function log(category, name, status, detail = '') {
  const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '❌';
  results.push({ category, name, status, detail });
  console.log(`${icon} [${category}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function testPage(page, path, expected = [200], opts = {}) {
  const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => null);
  if (!resp) { log(opts.category || 'page', path, 'fail', 'no response'); return null; }
  const status = resp.status();
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
  const ok = expected.includes(status);
  log(opts.category || 'page', path, ok ? 'ok' : 'fail', `${status}${!ok ? ' | ' + text.slice(0, 200).replace(/\n/g, ' ') : ''}`);
  return { status, text, url: page.url() };
}

async function testApi(page, method, path, body = null, opts = {}) {
  const resp = await page.request.fetch(BASE + path, {
    method, data: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' }, failOnStatusCode: false,
  }).catch(e => null);
  if (!resp) { log(opts.category || 'api', `${method} ${path}`, 'fail', 'no response'); return null; }
  const status = resp.status();
  const text = await resp.text().catch(() => '');
  const expected = opts.expected || [200];
  const ok = expected.includes(status);
  log(opts.category || 'api', `${method} ${path}`, ok ? (status >= 400 ? 'warn' : 'ok') : 'fail', `${status}${!ok ? ' | ' + text.slice(0, 150) : ''}`);
  return { status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

console.log('\n=== PUBLIC PAGES ===\n');
await testPage(page, '/', [200], { category: 'public' });
await testPage(page, '/pricing', [200], { category: 'public' });
await testPage(page, '/status', [200], { category: 'public' });
await testPage(page, '/changelog', [200], { category: 'public' });
await testPage(page, '/roadmap', [200], { category: 'public' });
await testPage(page, '/explore', [200], { category: 'public' });
await testPage(page, '/blog', [200], { category: 'public' });
await testPage(page, '/legal/terms', [200], { category: 'public' });
await testPage(page, '/legal/privacy', [200], { category: 'public' });
await testPage(page, '/legal/cookies', [200], { category: 'public' });
await testPage(page, '/legal/imprint', [200], { category: 'public' });
await testPage(page, '/sitemap.xml', [200], { category: 'public' });
await testPage(page, '/robots.txt', [200], { category: 'public' });
await testApi(page, 'GET', '/blog/atom.xml', null, { category: 'public' });
await testApi(page, 'GET', '/api/og/explore?topic=react', null, { category: 'public' });
await testApi(page, 'GET', '/api/health', null, { category: 'public' });

console.log('\n=== PUBLIC APIs ===\n');
await testApi(page, 'GET', '/api/search/builders?q=react', null, { category: 'api' });
await testApi(page, 'GET', '/api/builders/recent', null, { category: 'api' });
await testApi(page, 'GET', '/api/changelog', null, { category: 'api' });
await testApi(page, 'GET', '/api/status', null, { category: 'api' });
await testApi(page, 'GET', '/api/roadmap', null, { category: 'api' });
await testApi(page, 'GET', '/api/incidents', null, { category: 'api' });

console.log('\n=== AUTH PAGES (no auth, expect redirect or 200) ===\n');
const authExpected = [200, 302, 303];
for (const p of ['/search', '/search?q=react', '/dashboard', '/alerts', '/me', '/settings/billing', '/settings/privacy',
  '/admin/users', '/admin/changelog', '/admin/incidents', '/admin/roadmap', '/admin/plan-requests', '/admin/metrics',
  '/exports', '/onboarding/welcome']) {
  await testPage(page, p, authExpected, { category: 'auth' });
}

console.log('\n=== AUTH APIs (no auth) ===\n');
for (const p of ['/api/queries', '/api/recommendations', '/api/dashboard/stats', '/api/plans/me',
  '/api/me/plan-changes', '/api/alerts/triggers', '/api/onboarding/status', '/api/me/data-export']) {
  await testApi(page, 'GET', p, null, { category: 'auth-api', expected: [200, 401, 403] });
}

console.log('\n=== SIGN IN ===\n');
await page.goto(BASE + '/auth/sign-in', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('#email').fill('edd_admin@local.com');
await page.locator('#password').fill('Passw0rd!234');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(5000);
const signedIn = !page.url().includes('/auth/sign-in');
log('auth', 'sign in admin', signedIn ? 'ok' : 'fail', `URL=${page.url()}`);

if (signedIn) {
  console.log('\n=== AUTHENTICATED PAGES (admin) ===\n');
  for (const p of ['/dashboard', '/search', '/search?q=react', '/alerts', '/me', '/settings/billing', '/settings/privacy',
    '/admin/users', '/admin/changelog', '/admin/incidents', '/admin/roadmap', '/admin/plan-requests', '/admin/metrics',
    '/exports', '/onboarding/welcome']) {
    await testPage(page, p, [200], { category: 'auth-page' });
  }

  console.log('\n=== AUTHENTICATED APIs ===\n');
  for (const p of ['/api/queries', '/api/recommendations', '/api/dashboard/stats', '/api/plans/me',
    '/api/me/plan-changes', '/api/alerts/triggers', '/api/onboarding/status', '/api/me/data-export',
    '/api/admin/users', '/api/admin/changelog', '/api/admin/incidents', '/api/admin/roadmap',
    '/api/admin/plan-requests', '/api/admin/metrics', '/api/search/builders?q=react']) {
    await testApi(page, 'GET', p, null, { category: 'auth-api' });
  }
}

console.log('\n\n=== SUMMARY ===\n');
const ok = results.filter(r => r.status === 'ok').length;
const warn = results.filter(r => r.status === 'warn').length;
const fail = results.filter(r => r.status === 'fail').length;
console.log(`Total: ${results.length} | ✅ ${ok} | ⚠️ ${warn} | ❌ ${fail}`);

console.log('\n=== FAILURES ===\n');
for (const r of results.filter(r => r.status === 'fail')) console.log(`❌ [${r.category}] ${r.name} — ${r.detail}`);
console.log('\n=== WARNINGS ===\n');
for (const r of results.filter(r => r.status === 'warn')) console.log(`⚠️ [${r.category}] ${r.name} — ${r.detail}`);

await browser.close();
process.exit(fail > 0 ? 1 : 0);
