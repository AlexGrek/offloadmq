import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    proxy: {
      '/management': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:3069',
        changeOrigin: true,
        rewrite: (path) => path
      },
      '/api': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:3069',
        changeOrigin: true,
        rewrite: (path) => path
      }
    }
  }
})
