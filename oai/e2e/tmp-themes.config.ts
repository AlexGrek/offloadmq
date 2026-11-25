import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '/Users/vedmedik/dev/offloadmq/oai/e2e/tests', use: { baseURL: 'http://127.0.0.1:3131' }, workers: 4, reporter: 'line' })
