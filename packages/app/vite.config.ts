import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Plugin to discover datasets before build
function discoverDatasetsPlugin() {
  return {
    name: 'discover-datasets',
    buildStart() {
      // Skip during build - run `npm run discover-datasets` manually before building
      // The buildEnd hook below will attempt discovery but won't fail the build
    },
    buildEnd() {
      // Optional: try to discover datasets but don't fail build if it errors
      // Users should run `npm run discover-datasets` before building
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [discoverDatasetsPlugin(), react()],
  server: {
    allowedHosts: ['fumy-nonrhythmically-roxane.ngrok-free.dev']
  }
})
