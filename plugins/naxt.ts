import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'pathe';
import { angular } from '@oxc-angular/vite';
import { nitro } from 'nitro/vite';
import { angularPages } from './angular-pages';
import type { AngularPagesOptions, AngularPagesModule } from './angular-pages';
import type { Plugin } from 'vite';

const VIRTUAL_APP_CONFIG = 'virtual:naxt/app-config';
const RESOLVED_APP_CONFIG = '\0naxt:app-config';
const VIRTUAL_APP_CONFIG_SERVER = 'virtual:naxt/app-config-server';
const RESOLVED_APP_CONFIG_SERVER = '\0naxt:app-config-server';

// ─── Options ──────────────────────────────────────────────────────────

export interface NaxtOptions {
  /** Path to root App component (without extension). Default: 'app/app' */
  appComponent?: string;
  /** HTML document title. Default: '' */
  title?: string;
  /** Global CSS files to include in SSR (root-relative paths). Default: ['app/styles.css'] */
  css?: string[];
  /** Naxt modules (like Nuxt modules) */
  modules?: AngularPagesModule[];
  /** Nitro configuration — passed directly to nitro() */
  nitro?: Parameters<typeof nitro>[0];
  /** @oxc-angular/vite options — passed directly to angular() */
  angular?: Parameters<typeof angular>[0];
  /** angular-pages options (pagesDir, etc.) */
  pages?: Omit<AngularPagesOptions, 'modules'>;
}

// ─── Code generation ──────────────────────────────────────────────────

function resolveCssPaths(css: string[]): string[] {
  return css.map(f => f.replace(/^~\//, ''));
}

function generateCssImports(css: string[]): string {
  return resolveCssPaths(css).map(f => `import '/${f}';`).join('\n');
}

function generateEntryClient(appComponent: string, css: string[]): string {
  const cssImports = generateCssImports(css);
  return [
    "import { bootstrapApplication } from '@angular/platform-browser';",
    "import { appConfig } from 'virtual:naxt/app-config';",
    `import { App } from '/${appComponent}';`,
    cssImports,
    '',
    'bootstrapApplication(App, appConfig)',
    '  .catch((err) => console.error(err));',
    '',
  ].join('\n');
}

function generateEntryServer(appComponent: string, title: string, css: string[]): string {
  const cssImports = generateCssImports(css);

  const htmlTemplateFn = [
    'function htmlTemplate(): string {',
    "  const selector = reflectComponentType(App)?.selector || 'app-root';",
    '  return `<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `  <title>${title}</title>`,
    '</head>',
    '<body>',
    '  <${selector}></${selector}>',
    '</body>',
    '</html>`;',
    '}',
  ].join('\n');

  return `import '@angular/compiler';
${cssImports}
import { renderApplication } from '@angular/platform-server';
import { reflectComponentType } from '@angular/core';
import { BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { createHead, transformHtmlTemplate } from 'unhead/server';

import { App } from '/${appComponent}';
import { config } from 'virtual:naxt/app-config-server';

import clientAssets from "./entry-client?assets=client";
import serverAssets from "./entry-server?assets=ssr";

const bootstrap = (context: BootstrapContext) =>
    bootstrapApplication(App, config, context);

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const assets = clientAssets.merge(serverAssets);

  const head = createHead();

  head.push({
    link: [
      ...assets.css.map((attrs: any) => ({ rel: "stylesheet", ...attrs })),
      ...assets.js.map((attrs: any) => ({ rel: "modulepreload", ...attrs })),
    ],
    script: [{ type: "module", src: clientAssets.entry }],
  });

  const renderedApp = await renderApplication(bootstrap, {
    document: htmlTemplate(),
    url: url.href,
  });

  const html = await transformHtmlTemplate(head, renderedApp);

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

${htmlTemplateFn}

export default {
  fetch: handler,
};
`;
}

function generateAppConfig(): string {
  return `import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from 'virtual:angular-pages';
import { provideClientHydration } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';

export const appConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideClientHydration(),
    provideHttpClient(withFetch()),
  ],
};
`;
}

function generateAppConfigServer(): string {
  return `import { mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/ssr';
import { appConfig } from 'virtual:naxt/app-config';

const serverConfig = {
  providers: [
    provideServerRendering(),
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
`;
}

// ─── Plugin ───────────────────────────────────────────────────────────

export function naxt(options?: NaxtOptions): Plugin[] {
  const appComponent = options?.appComponent ?? 'app/app';
  const title = options?.title ?? '';
  const css = options?.css ?? ['app/styles.css'];

  const naxtPlugin: Plugin = {
    name: 'naxt',
    enforce: 'pre',

    config(userConfig) {
      const root = userConfig.root ?? process.cwd();
      const naxtDir = resolve(root, '.naxt');

      // Generate entry files
      mkdirSync(naxtDir, { recursive: true });
      writeFileSync(join(naxtDir, 'entry-client.ts'), generateEntryClient(appComponent, css));
      writeFileSync(join(naxtDir, 'entry-server.ts'), generateEntryServer(appComponent, title, css));

      return {
        resolve: {
          alias: {
            '~': root,
            '#plugins': resolve(root, 'plugins'),
          },
        },
        environments: {
          ssr: {
            build: {
              rollupOptions: {
                input: join(naxtDir, 'entry-server.ts'),
              },
            },
          },
        },
      };
    },

    resolveId(id) {
      if (id === VIRTUAL_APP_CONFIG) return RESOLVED_APP_CONFIG;
      if (id === VIRTUAL_APP_CONFIG_SERVER) return RESOLVED_APP_CONFIG_SERVER;
    },

    load(id) {
      if (id === RESOLVED_APP_CONFIG) return generateAppConfig();
      if (id === RESOLVED_APP_CONFIG_SERVER) return generateAppConfigServer();
    },
  };

  const angularOpts = options?.angular ?? {
    tsconfig: resolve(process.cwd(), 'tsconfig.app.json'),
  };

  return [
    naxtPlugin,
    ...(nitro(options?.nitro) as Plugin[]),
    ...angularPages({ ...options?.pages, modules: options?.modules }),
    ...(angular(angularOpts) as Plugin[]),
  ];
}
