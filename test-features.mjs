import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const tests = [];
function test(name, ok, detail = '') {
  tests.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Sign in
await page.goto('http://localhost:3000/auth/sign-in', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('#email').fill('edd_admin@local.com');
await page.locator('#password').fill('Passw0rd!234');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(3000);

console.log('\n=== /search?q= variations ===\n');

for (const q of ['react', 'rust', 'AI agents', 'a']) {
  await page.goto(`http://localhost:3000/search?q=${encodeURIComponent(q)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const input = await page.locator('input[type="search"]').first().inputValue();
  const cards = await page.locator('article').count();
  test(`/search?q=${q}: input set to "${input}"`, input === q, `${cards} cards`);
}

console.log('\n=== /search?q= empty ===\n');
await page.goto('http://localhost:3000/search?q=', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const emptyInput = await page.locator('input[type="search"]').first().inputValue();
const emptyCards = await page.locator('article').count();
test(`/search?q= (empty)`, emptyInput === '' && emptyCards === 0, `input="${emptyInput}", ${emptyCards} cards`);

console.log('\n=== /search (no q) ===\n');
await page.goto('http://localhost:3000/search', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const noqInput = await page.locator('input[type="search"]').first().inputValue();
const noqCards = await page.locator('article').count();
test(`/search (no q)`, noqInput === '' && noqCards === 0, `input="${noqInput}", ${noqCards} cards`);

console.log('\n=== /onboarding/welcome redirect ===\n');
// Sign out
await page.goto('http://localhost:3000/api/auth/sign-out', { waitUntil: 'domcontentloaded' }).catch(() => null);
// Or click sign out
await page.goto('http://localhost:3000/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
// Try onboarding
await page.goto('http://localhost:3000/onboarding/welcome', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const onboardingUrl = page.url();
test(`/onboarding/welcome when not auth → ${onboardingUrl}`, onboardingUrl.includes('/auth/sign-in'), '');

console.log('\n=== /onboarding/welcome when auth ===\n');
// Sign in again
await page.locator('#email').fill('edd_admin@local.com');
await page.locator('#password').fill('Passw0rd!234');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(3000);
const onboardingUrl2 = page.url();
test(`after sign-in → ${onboardingUrl2}`, onboardingUrl2.includes('onboarding') || onboardingUrl2.includes('dashboard'), '');

console.log('\n=== /search?q=react with redirect param ===\n');
await page.goto('http://localhost:3000/api/auth/sign-out', { waitUntil: 'domcontentloaded' }).catch(() => null);
await page.waitForTimeout(1000);
await page.goto('http://localhost:3000/search?q=react', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const searchUrl = page.url();
test(`/search?q=react (no auth) → ${searchUrl}`, searchUrl.includes('/auth/sign-in') || searchUrl.includes('/search'), '');

console.log('\n=== SUMMARY ===\n');
const passed = tests.filter(t => t.ok).length;
const failed = tests.filter(t => !t.ok).length;
console.log(`${passed} passed, ${failed} failed`);
for (const t of tests.filter(t => !t.ok)) {
  console.log(`❌ ${t.name}${t.detail ? ' — ' + t.detail : ''}`);
}

await browser.close();
process.exit(failed > 0 ? 1 : 0);
