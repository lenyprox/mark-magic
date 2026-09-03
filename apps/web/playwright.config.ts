import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3199);

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', viewport: { width: 1400, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next dev --webpack --port ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
