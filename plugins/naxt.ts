import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'pathe';
import { angular } from '@oxc-angular/vite';
import { nitro } from 'nitro/vite';
import { angularPages } from './angular-pages';
import type { AngularPagesOptions, AngularPagesModule } from './angular-pages';
import type { Head } from 'unhead/types';
import type { Plugin } from 'vite';

const VIRTUAL_APP_CONFIG = 'virtual:naxt/app-config';
const RESOLVED_APP_CONFIG = '\0naxt:app-config';
const VIRTUAL_APP_CONFIG_SERVER = 'virtual:naxt/app-config-server';
const RESOLVED_APP_CONFIG_SERVER = '\0naxt:app-config-server';

// ─── Options (Nuxt-style) ────────────────────────────────────────────

export interface NaxtAppOptions {
  /** Default `<head>` configuration for every page (uses unhead). */
  head?: Head;
}

export interface NaxtOptions {
  /** App configuration (head, etc.) — same as Nuxt's `app`. */
  app?: NaxtAppOptions;
  /** Global CSS files. Supports `~/` prefix for root-relative paths. */
  css?: string[];
  /** Naxt modules (like Nuxt modules) */
  modules?: AngularPagesModule[];
  /** Source directory. Default: 'app' */
  srcDir?: string;
  /** Nitro configuration — passed directly to nitro() */
  nitro?: Parameters<typeof nitro>[0];
  /** @oxc-angular/vite options — passed directly to angular() */
  angular?: Parameters<typeof angular>[0];
  /** angular-pages options (pagesDir, etc.) */
  pages?: Omit<AngularPagesOptions, 'modules'>;
  /** TypeScript configuration overrides */
  typescript?: {
    /** Merge additional settings into tsconfig */
    tsConfig?: Record<string, unknown>;
    /** Enable strict mode. Default: true */
    strict?: boolean;
  };
}

// ─── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_HEAD: Head = {
  meta: [
    { charset: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
  ],
  link: [],
  style: [],
  script: [],
  noscript: [],
};

function mergeHead(defaults: Head, overrides?: Head): Head {
  if (!overrides) return defaults;
  return {
    title: overrides.title ?? defaults.title,
    titleTemplate: overrides.titleTemplate ?? defaults.titleTemplate,
    base: overrides.base ?? defaults.base,
    templateParams: { ...defaults.templateParams, ...overrides.templateParams },
    meta: [...(defaults.meta ?? []), ...(overrides.meta ?? [])],
    link: [...(defaults.link ?? []), ...(overrides.link ?? [])],
    style: [...(defaults.style ?? []), ...(overrides.style ?? [])],
    script: [...(defaults.script ?? []), ...(overrides.script ?? [])],
    noscript: [...(defaults.noscript ?? []), ...(overrides.noscript ?? [])],
    htmlAttrs: { ...defaults.htmlAttrs, ...overrides.htmlAttrs },
    bodyAttrs: { ...defaults.bodyAttrs, ...overrides.bodyAttrs },
  };
}

// ─── Code generation ──────────────────────────────────────────────────

function generateCssImports(css: string[]): string {
  return css.map(f => `import '${f}';`).join('\n');
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

function generateEntryServer(appComponent: string, head: Head, css: string[]): string {
  const cssImports = generateCssImports(css);
  const headJson = JSON.stringify(head);

  return `import '@angular/compiler';
${cssImports}
import { renderApplication } from '@angular/platform-server';
import { reflectComponentType } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { createHead, transformHtmlTemplate } from 'unhead/server';

import { App } from '/${appComponent}';
import { config } from 'virtual:naxt/app-config-server';

import clientAssets from "./entry-client?assets=client";
import serverAssets from "./entry-server?assets=ssr";

const bootstrap = (context) =>
    bootstrapApplication(App, config, context);

const defaultHead = ${headJson};

async function handler(request) {
  const url = new URL(request.url);

  const assets = clientAssets.merge(serverAssets);

  const head = createHead();

  // Push default head config (title, meta, etc.)
  head.push(defaultHead);

  // Push asset tags
  head.push({
    link: [
      ...assets.css.map((attrs) => ({ rel: "stylesheet", ...attrs })),
      ...assets.js.map((attrs) => ({ rel: "modulepreload", ...attrs })),
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

function htmlTemplate() {
  const selector = reflectComponentType(App)?.selector || 'app-root';
  return \`<!DOCTYPE html>
<html>
<head></head>
<body>
  <\${selector}></\${selector}>
</body>
</html>\`;
}

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

// ─── TypeScript config generation ─────────────────────────────────────

function generateBaseTsConfig(
  root: string,
  naxtDir: string,
  aliases: Record<string, string>,
  strict: boolean,
  userOverrides?: Record<string, unknown>,
): string {
  const relRoot = relative(naxtDir, root);
  const paths: Record<string, string[]> = {};
  for (const [alias, target] of Object.entries(aliases)) {
    let relTarget = relative(naxtDir, target) || '.';
    if (alias.endsWith('/*')) {
      paths[alias] = [`${relTarget}/*`];
    } else {
      paths[alias] = [relTarget];
    }
  }

  const config: Record<string, unknown> = {
    compilerOptions: {
      strict,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      skipLibCheck: true,
      isolatedModules: true,
      experimentalDecorators: true,
      importHelpers: true,
      target: 'ES2022',
      module: 'preserve',
      baseUrl: '.',
      rootDir: relRoot,
      paths,
      ...(userOverrides as Record<string, unknown>),
    },
    angularCompilerOptions: {
      enableI18nLegacyMessageIdFormat: false,
      strictInjectionParameters: true,
      strictInputAccessModifiers: true,
      strictTemplates: true,
    },
  };

  return JSON.stringify(config, null, 2) + '\n';
}

function generateAppTsConfig(
  naxtDir: string,
  root: string,
  srcDir: string,
): string {
  const relSrcDir = relative(naxtDir, resolve(root, srcDir));
  const relPluginsDir = relative(naxtDir, resolve(root, 'plugins'));

  const config = {
    extends: './tsconfig.json',
    compilerOptions: {
      outDir: relative(naxtDir, resolve(root, 'out-tsc/app')),
      types: ['node'],
    },
    include: [
      `${relSrcDir}/**/*.ts`,
      `${relPluginsDir}/content-renderer.ts`,
    ],
    exclude: [
      `${relSrcDir}/**/*.spec.ts`,
    ],
  };

  return JSON.stringify(config, null, 2) + '\n';
}

function generateSpecTsConfig(
  naxtDir: string,
  root: string,
  srcDir: string,
): string {
  const relSrcDir = relative(naxtDir, resolve(root, srcDir));

  const config = {
    extends: './tsconfig.json',
    compilerOptions: {
      outDir: relative(naxtDir, resolve(root, 'out-tsc/spec')),
    },
    include: [
      `${relSrcDir}/**/*.d.ts`,
      `${relSrcDir}/**/*.spec.ts`,
    ],
  };

  return JSON.stringify(config, null, 2) + '\n';
}

function generateRootTsConfig(naxtDir: string, root: string): string {
  const relNaxt = relative(root, naxtDir);

  const config = {
    files: [],
    references: [
      { path: `${relNaxt}/tsconfig.app.json` },
      { path: `${relNaxt}/tsconfig.spec.json` },
    ],
  };

  return JSON.stringify(config, null, 2) + '\n';
}

// ─── Plugin ───────────────────────────────────────────────────────────

export function naxt(options?: NaxtOptions): Plugin[] {
  const srcDir = options?.srcDir ?? 'app';
  const appComponent = `${srcDir}/app`;
  const head = mergeHead(DEFAULT_HEAD, options?.app?.head);
  const css = options?.css ?? ['~/styles.css'];

  const naxtPlugin: Plugin = {
    name: 'naxt',
    enforce: 'pre',

    config(userConfig) {
      const root = userConfig.root ?? process.cwd();
      const naxtDir = resolve(root, '.naxt');

      const aliases: Record<string, string> = {
        '~': resolve(root, srcDir),
        '~~': root,
        '#plugins/*': resolve(root, 'plugins'),
        '#build': naxtDir,
      };

      // Generate .naxt/ directory
      mkdirSync(naxtDir, { recursive: true });

      // Generate entry files
      writeFileSync(join(naxtDir, 'entry-client.ts'), generateEntryClient(appComponent, css));
      writeFileSync(join(naxtDir, 'entry-server.ts'), generateEntryServer(appComponent, head, css));

      // Generate tsconfig files
      writeFileSync(
        join(naxtDir, 'tsconfig.json'),
        generateBaseTsConfig(
          root,
          naxtDir,
          aliases,
          options?.typescript?.strict ?? true,
          options?.typescript?.tsConfig,
        ),
      );
      writeFileSync(
        join(naxtDir, 'tsconfig.app.json'),
        generateAppTsConfig(naxtDir, root, srcDir),
      );
      writeFileSync(
        join(naxtDir, 'tsconfig.spec.json'),
        generateSpecTsConfig(naxtDir, root, srcDir),
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        generateRootTsConfig(naxtDir, root),
      );

      return {
        build: {
          // Nitro's server environment can inherit top-level build input as a fallback.
          // Keep it server-safe to avoid SSR builds defaulting to index.html.
          rollupOptions: {
            input: {
              index: '#nitro-vite-setup',
            },
          },
        },
        resolve: {
          alias: {
            '~': resolve(root, srcDir),
            '~~': root,
            '#plugins': resolve(root, 'plugins'),
            '#build': naxtDir,
          },
        },
        environments: {
          client: {
            build: {
              rollupOptions: {
                input: join(naxtDir, 'entry-client.ts'),
              },
            },
          },
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
    tsconfig: resolve(process.cwd(), '.naxt/tsconfig.app.json'),
  };

  return [
    naxtPlugin,
    ...(nitro(options?.nitro) as Plugin[]),
    ...angularPages({ ...options?.pages, modules: options?.modules }),
    ...(angular(angularOpts) as Plugin[]),
  ];
}
