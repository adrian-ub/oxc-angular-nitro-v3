// vite.config.ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import { angular } from '@oxc-angular/vite'
import { nitro } from "nitro/vite"
import { angularPages } from './plugins/angular-pages'
import { angularContent } from './plugins/angular-content'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const tsconfig = path.resolve(__dirname, './tsconfig.app.json')

export default defineConfig({
  resolve: {
    alias: {
      '#plugins': path.resolve(__dirname, 'plugins'),
    },
  },
  plugins: [
    nitro({
      preset: "static",
      serverDir: true,
      prerender: {
        routes: ['/']
      },
    }),
    angularPages({
      modules: [
        angularContent(),
      ],
    }),
    angular({
      tsconfig,
    }),
  ]
});
