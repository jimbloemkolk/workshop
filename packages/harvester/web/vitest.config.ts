import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts (not merged in) so `vitest run` can't ever
// perturb the dev-server/build config (proxy target, port) — this only
// needs the React plugin (for JSX in .test.tsx) plus a jsdom environment.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
  },
})
