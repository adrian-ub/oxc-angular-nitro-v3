import { defineConfig } from 'vite'
import { naxt } from './plugins/naxt'
import { angularContent } from './plugins/angular-content'

export default defineConfig({
  plugins: [
    naxt({
      title: 'Nitro + Angular',
      modules: [
        angularContent(),
      ],
      nitro: {
        preset: "static",
        serverDir: true,
        prerender: {
          routes: ['/']
        },
      },
    }),
  ],
});
