import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backend = 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/agent': backend,
      '/config': backend,
      '/capabilities': backend,
      '/slavemode-caps': backend,
      '/scan': backend,
      '/install': backend,
      '/workflows': backend,
    },
  },
})
