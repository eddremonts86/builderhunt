import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on('console', msg => console.log('CONSOLE:', msg.text()));
page.on('pageerror', err => console.log('PAGEERROR:', err.message));
page.on('requestfailed', req => console.log('REQFAIL:', req.url(), req.failure()?.errorText));
page.on('response', resp => {
  if (resp.url().includes('/api/auth/')) {
    console.log('AUTH_API:', resp.status(), resp.url());
  }
});

await page.goto('http://localhost:3000/auth/sign-in', { waitUntil: 'networkidle' });

// Wait for hydration
await page.waitForTimeout(2000);

await page.locator('#email').fill('edd_admin@local.com');
await page.locator('#password').fill('Passw0rd!234');

console.log('Before click, URL:', page.url());

// Click submit
await page.locator('button[type="submit"]').click();

// Wait for navigation
await page.waitForTimeout(5000);

console.log('After wait, URL:', page.url());

// Check for error
const errorVisible = await page.locator('[role="alert"]').isVisible().catch(() => false);
if (errorVisible) {
  const errText = await page.locator('[role="alert"]').textContent();
  console.log('ERROR:', errText);
}

await page.screenshot({ path: '/tmp/signin-test.png', fullPage: true });

await browser.close();
