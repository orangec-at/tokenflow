import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Point at source so the demo reloads when the library changes.
    alias: { tokenflow: resolve(__dirname, '../src/index.ts') },
  },
})
