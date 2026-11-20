import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-globals': ['error', 'alert', 'confirm', 'prompt'],
      'no-restricted-properties': ['error', ...['window', 'globalThis', 'self'].flatMap(object =>
        ['alert', 'confirm', 'prompt'].map(property => ({ object, property, message: 'Use an in-app modal instead of a native browser dialog.' })),
      )],
    },
  },
])
