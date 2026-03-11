import { resolve, relative } from 'node:path';
import { glob } from 'tinyglobby';
import type { Plugin } from 'vite';

const VIRTUAL_MODULE_ID = 'virtual:angular-pages';
const RESOLVED_VIRTUAL_MODULE_ID = '\0' + VIRTUAL_MODULE_ID;

const GLOB_SCAN_PATTERN = '**/*.ts';

/**
 * Converts a file path inside pages/ to an Angular route path.
 *
 * Conventions:
 *   index.ts        → ''
 *   about.ts        → 'about'
 *   blog/index.ts   → 'blog'
 *   blog/[id].ts    → 'blog/:id'
 *   blog/[...slug].ts → 'blog/**'
 *   (group)/settings.ts → 'settings'   (parenthesized segments are removed)
 */
function fileToRoute(filePath: string): string {
  let route = filePath
    .replace(/\.ts$/, '')                                 // strip extension
    .replace(/\(([^)]+)\)[/\\]/g, '')                     // remove (group)/ segments
    .replace(/\[\.\.\.([^\]]*)\]/g, '**')                 // [...slug] → **
    .replace(/\[([^\]]+)\]/g, ':$1');                     // [id] → :id

  // Normalize to posix separators
  route = route.split('\\').join('/');

  // Remove trailing /index or standalone index
  route = route.replace(/\/index$/, '').replace(/^index$/, '');

  return route;
}

async function scanPages(pagesDir: string): Promise<{ filePath: string; route: string; catchAllParam?: string }[]> {
  const files = await glob(GLOB_SCAN_PATTERN, {
    cwd: pagesDir,
    ignore: ['**/*.spec.ts', '**/*.test.ts'],
  });

  return files
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const catchAllMatch = file.match(/\[\.\.\.([^\]]*)\]/);
      return {
        filePath: resolve(pagesDir, file),
        route: fileToRoute(file),
        catchAllParam: catchAllMatch?.[1],
      };
    });
}

function generateRoutesCode(pages: { filePath: string; route: string; catchAllParam?: string }[], root: string): string {
  const routeEntries: string[] = [];

  for (const { filePath, route, catchAllParam } of pages) {
    const importPath = '/' + relative(root, filePath).split('\\').join('/');
    const loadComponent = `() => import('${importPath}').then(m => resolveComponent(m, '${importPath}'))`;

    // Catch-all routes: 'other/**' → { path: 'other', children: [{ path: '**', loadComponent, data }] }
    // This ensures ActivatedRoute.snapshot.url only contains the wildcard segments
    if (route.includes('**')) {
      const idx = route.indexOf('**');
      const parent = route.slice(0, idx).replace(/\/$/, '');
      const dataStr = catchAllParam ? `, data: { _catchAllParam: '${catchAllParam}' }` : '';
      if (parent) {
        routeEntries.push(
          `  { path: '${parent}', children: [{ path: '**', loadComponent: ${loadComponent}${dataStr} }] }`
        );
      } else {
        routeEntries.push(
          `  { path: '**', loadComponent: ${loadComponent}${dataStr} }`
        );
      }
    } else {
      routeEntries.push(
        `  { path: '${route}', loadComponent: ${loadComponent} }`
      );
    }
  }

  return `import { ɵNG_COMP_DEF as NG_COMP_DEF } from '@angular/core';
import { EmptyPage as _placeholder } from '/plugins/empty-page';

function resolveComponent(m, path) {
  const isComponent = (v) => typeof v === 'function' && v[NG_COMP_DEF];

  // 1. Prefer default export if it's a component
  if (m.default && isComponent(m.default)) return m.default;

  // 2. Search all exports for a component
  const component = Object.values(m).find(isComponent);
  if (component) {
    if (m.default) {
      if (import.meta.env.DEV) {
        console.warn(\`[angular-pages] \${path}: default export is not a @Component, using first @Component found.\`);
      }
    }
    return component;
  }

  // 3. No component found — use empty placeholder (file may be in progress)
  if (import.meta.env.DEV) {
    console.warn(\`[angular-pages] \${path}: no @Component found, rendering empty page.\`);
  }
  return _placeholder;
}

export const routes = [
${routeEntries.join(',\n')}
];
`;
}

export function angularPages(options?: { pagesDir?: string }): Plugin {
  const pagesDir = options?.pagesDir ?? resolve(process.cwd(), 'app/pages');
  let root: string;
  let pages: { filePath: string; route: string }[] = [];

  return {
    name: 'angular-pages',

    async configResolved(config) {
      root = config.root;
      pages = await scanPages(pagesDir);
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID;
      }
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        return generateRoutesCode(pages, root);
      }
    },

    configureServer(server) {
      server.watcher.add(pagesDir);

      const reloadRoutes = async (path: string) => {
        const rel = relative(pagesDir, path);
        if (rel.startsWith('..') || !rel.endsWith('.ts')) return;

        pages = await scanPages(pagesDir);
        const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }
      };

      server.watcher.on('add', reloadRoutes);
      server.watcher.on('unlink', reloadRoutes);
    },
  };
}
