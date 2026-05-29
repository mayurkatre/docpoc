import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dns from 'dns'

// Fix Node.js DNS resolution issues on Windows
dns.setDefaultResultOrder('ipv4first')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/nvidia-api': {
        target: 'https://integrate.api.nvidia.com',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/nvidia-api/, ''),
      },
    },
  },
})
