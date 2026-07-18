import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on('console', msg => console.log('CONSOLE:', msg.text()));
page.on('pageerror', err => console.log('PAGEERROR:', err.message));
page.on('response', resp => {
  if (resp.url().includes('/api/search')) {
    console.log('API:', resp.status(), resp.url());
  }
});

// Sign in
await page.goto('http://localhost:3000/auth/sign-in', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('#email').fill('edd_admin@local.com');
await page.locator('#password').fill('Passw0rd!234');
await page.locator('button[type="submit"]').click();
await page.waitForTimeout(3000);
console.log('Signed in, URL:', page.url());

// Go to /search?q=react
console.log('\n=== Going to /search?q=react ===\n');
await page.goto('http://localhost:3000/search?q=react', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// Check input value
const inputValue = await page.locator('input[type="search"]').first().inputValue();
console.log('Input value:', JSON.stringify(inputValue));

// Check for result cards
const cardCount = await page.locator('article').count();
console.log('Result cards:', cardCount);

// Check URL
console.log('Current URL:', page.url());

// Check for the loading state
const loadingVisible = await page.locator('[role="status"]').isVisible().catch(() => false);
console.log('Loading visible:', loadingVisible);

// Get the body text
const bodyText = await page.locator('body').textContent();
console.log('Has "results matching":', bodyText?.includes('results matching') || bodyText?.includes('result matching'));

// Get text around result count
const resultText = await page.locator('text=/\\d+ result/').first().textContent().catch(() => 'NOT FOUND');
console.log('Result text:', resultText);

await page.screenshot({ path: '/tmp/search-debug.png', fullPage: true });

await browser.close();
