// vite.config.ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import { angular } from '@oxc-angular/vite'
import { nitro } from "nitro/vite"
import { angularPages } from './plugins/angular-pages'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const tsconfig = path.resolve(__dirname, './tsconfig.app.json')

export default defineConfig({
  plugins: [
    nitro({
      preset: "static",
      serverDir: true,
      prerender: {
        routes: ['/']
      },
    }),
    angularPages(),
    angular({
      tsconfig,
    }),
  ],
  environments: {
    client: {
      build: { rollupOptions: { input: "./entry-client.ts" } },
    },
  },
});
