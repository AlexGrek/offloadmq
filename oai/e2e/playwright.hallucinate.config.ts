import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests', fullyParallel: true, reporter: 'list',
  outputDir: '/tmp/hallucinate-test-results',
  use: { baseURL: 'http://localhost:5192' },
  webServer: { command: 'npm --prefix ../frontend run dev -- --port 5192', url: 'http://localhost:5192' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
