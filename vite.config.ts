import { defineConfig } from 'vite'
import { naxt } from './plugins/naxt'
import { angularContent } from './plugins/angular-content'

export default defineConfig({
  plugins: [
    naxt({
      app: {
        head: {
          title: 'Nitro + Angular',
          meta: [
            { name: 'description', content: 'Nitro + Angular application' },
          ],
        },
      },
      css: ['~/styles.css'],
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
