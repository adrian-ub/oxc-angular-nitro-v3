import { defineConfig } from 'vitest/config'
import { angular } from '@oxc-angular/vite'

export default defineConfig({
  plugins: [
    angular({ liveReload: false }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test-setup.ts'],
  },
})
