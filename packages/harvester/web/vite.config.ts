import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = `http://127.0.0.1:${process.env.HARVESTER_PORT ?? 4747}`

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4748,
    proxy: {
      '/api': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
})
