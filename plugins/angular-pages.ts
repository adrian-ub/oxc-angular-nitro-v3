import { relative, resolve } from 'pathe';
import { glob } from 'tinyglobby';
import { addFile, buildTree, compileParsePath, removeFile } from 'unrouting';
import type {
  CompiledParsePath,
  ParsedPathSegment,
  ParsedPathSegmentToken,
  RouteNodeFile,
  RouteTree,
} from 'unrouting';
import type { Plugin } from 'vite';

const VIRTUAL_MODULE_ID = 'virtual:angular-pages';
const RESOLVED_VIRTUAL_MODULE_ID = '\0' + VIRTUAL_MODULE_ID;

// ─── Module system ────────────────────────────────────────────────────

export type AngularPagesModule = (ctx: AngularPagesModuleContext) => Plugin | void;

export interface AngularPagesModuleContext {
  /** Extend routes after generation from the file tree */
  extendRoutes(callback: ExtendRoutesCallback): void;
  /** Called when the pages route tree is invalidated (dev HMR) */
  onPagesReload(callback: () => void): void;
}

export type ExtendRoutesCallback = (routes: AngularRoute[]) => AngularRoute[] | void;

// ─── Route types ──────────────────────────────────────────────────────

export interface AngularRoute {
  path: string;
  file?: string;
  name?: string;
  children?: AngularRoute[];
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

// ─── Flatten tree (same pattern as unrouting's toVueRouter4) ──────────

interface FlatFileInfo {
  file: string;
  relativePath: string;
  segments: ParsedPathSegment[];
  groups: string[];
  siblingFiles: RouteNodeFile[];
}

function flattenTree(tree: RouteTree): FlatFileInfo[] {
  const infos: FlatFileInfo[] = [];
  (function walk(node) {
    const defaults = node.files.filter(f => f.viewName === 'default');

    const byGroupPath = new Map<string, RouteNodeFile[]>();
    for (const f of (defaults.length > 0 ? defaults : node.files)) {
      const key = f.groups.join(',');
      let group = byGroupPath.get(key);
      if (!group) { group = []; byGroupPath.set(key, group); }
      group.push(f);
    }

    for (const [, groupFiles] of byGroupPath) {
      const primary = groupFiles[0];
      const segments: ParsedPathSegment[] = [];
      for (const seg of primary.originalSegments) {
        if (!seg.every(t => t.type === 'group')) segments.push(seg);
      }
      infos.push({
        file: primary.path,
        relativePath: primary.relativePath,
        segments,
        groups: primary.groups,
        siblingFiles: groupFiles,
      });
    }
    for (const child of node.children.values()) walk(child);
  })(tree.root);
  return infos;
}

// ─── Angular path segment conversion ──────────────────────────────────

function isIndexSegment(tokens: ParsedPathSegment): boolean {
  return tokens.length === 1 && tokens[0].type === 'static' && tokens[0].value === '';
}

function toAngularSegment(tokens: ParsedPathSegmentToken[]): { segment: string; catchAllParam?: string } {
  let out = '';
  let catchAllParam: string | undefined;

  for (const token of tokens) {
    switch (token.type) {
      case 'group':
        continue;
      case 'static':
        out += token.value;
        break;
      case 'dynamic':
        out += `:${token.value}`;
        break;
      case 'optional':
        // Angular doesn't have optional segments — emit as dynamic
        out += `:${token.value}`;
        break;
      case 'catchall':
      case 'repeatable':
      case 'optional-repeatable':
        out = '**';
        catchAllParam = token.value;
        break;
    }
  }
  return { segment: out, catchAllParam };
}

// ─── toAngularRouter ──────────────────────────────────────────────────

const collator = new Intl.Collator('en-US');
const INDEX_RE = /\/index$/;
const SLASH_RE = /\//g;

interface IntermediateRoute {
  name: string;
  path: string;
  file: string;
  children: IntermediateRoute[];
  groups: string[];
  catchAllParam?: string;
  scoreSegments?: number[];
}

function defaultGetRouteName(rawName: string): string {
  return rawName.replace(INDEX_RE, '').replace(SLASH_RE, '-') || 'index';
}

function computeScoreSegments(route: IntermediateRoute): number[] {
  return route.path.split('/').filter(Boolean).map((part) => {
    if (part === '**') return -400;
    if (part.startsWith(':')) return 300;
    return 400;
  });
}

function compareRoutes(a: IntermediateRoute, b: IntermediateRoute): number {
  const aScore = a.scoreSegments!;
  const bScore = b.scoreSegments!;
  const len = Math.max(aScore.length, bScore.length);

  for (let i = 0; i < len; i++) {
    const sa = aScore[i] ?? -Infinity;
    const sb = bScore[i] ?? -Infinity;
    if (sa !== sb) return sb - sa;
  }

  return collator.compare(a.path, b.path);
}

function prepareRoutes(
  routes: IntermediateRoute[],
  parent?: IntermediateRoute,
): AngularRoute[] {
  for (const route of routes) {
    route.scoreSegments = computeScoreSegments(route);
  }
  routes.sort(compareRoutes);

  return routes.map((route) => {
    let name: string | undefined = defaultGetRouteName(route.name);
    let path = route.path;

    if (path[0] === '/') path = path.slice(1);

    const children = route.children.length ? prepareRoutes(route.children, route) : [];
    if (children.some(c => c.path === '')) name = undefined;

    const out: AngularRoute = { path };
    if (route.file) out.file = route.file;
    if (name !== undefined) out.name = name;
    if (route.groups.length > 0) out.meta = { groups: route.groups };
    if (route.catchAllParam) out.data = { _catchAllParam: route.catchAllParam };
    if (children.length > 0) out.children = children;

    return out;
  });
}

function toAngularRouter(tree: RouteTree): AngularRoute[] {
  const fileInfos = flattenTree(tree);

  fileInfos.sort((a, b) =>
    a.relativePath.length - b.relativePath.length
    || collator.compare(a.relativePath, b.relativePath),
  );

  const routes: IntermediateRoute[] = [];

  for (const info of fileInfos) {
    const route: IntermediateRoute = {
      name: '',
      path: '',
      file: info.file,
      children: [],
      groups: info.groups,
    };
    let parent = routes;

    if (info.segments.length === 0) route.path = '/';

    for (let i = 0; i < info.segments.length; i++) {
      const seg = info.segments[i];
      const isIndex = isIndexSegment(seg);
      const segmentName = isIndex
        ? 'index'
        : seg.map(t => t.type === 'group' ? '' : t.value).join('');

      route.name += (route.name && '/') + segmentName;

      const { segment: angularSegment, catchAllParam } = toAngularSegment(seg);
      if (catchAllParam) route.catchAllParam = catchAllParam;

      const routePath = isIndex ? '' : `/${angularSegment}`;
      const fullPath = (route.path || '/') + (isIndex ? '' : routePath);

      const match = parent.find(r =>
        r.name === route.name && r.path === fullPath,
      );

      if (match?.children) {
        parent = match.children;
        route.path = '';
      } else if (segmentName === 'index' && !route.path) {
        route.path += '/';
      } else if (segmentName !== 'index') {
        route.path += routePath;
      }
    }

    parent.push(route);
  }

  return prepareRoutes(routes);
}

// ─── Code generation ──────────────────────────────────────────────────

function generateRouteEntry(route: AngularRoute, root: string, indent: string = '  '): string {
  // Catch-all routes: split 'parent/**' into { path: 'parent', children: [{ path: '**' }] }
  if (route.path.includes('**') && route.file) {
    const idx = route.path.indexOf('**');
    const parent = route.path.slice(0, idx).replace(/\/$/, '');
    const importPath = '/' + relative(root, route.file);
    const loadComponent = `() => import('${importPath}').then(m => resolveComponent(m, '${importPath}'))`;
    const dataStr = route.data ? `, data: ${JSON.stringify(route.data)}` : '';

    if (parent) {
      return `${indent}{ path: '${parent}', children: [{ path: '**', loadComponent: ${loadComponent}${dataStr} }] }`;
    }
    return `${indent}{ path: '**', loadComponent: ${loadComponent}${dataStr} }`;
  }

  const parts: string[] = [];
  parts.push(`path: '${route.path}'`);

  if (route.file) {
    const importPath = '/' + relative(root, route.file);
    const loadComponent = `() => import('${importPath}').then(m => resolveComponent(m, '${importPath}'))`;
    parts.push(`loadComponent: ${loadComponent}`);
  }

  if (route.data) {
    parts.push(`data: ${JSON.stringify(route.data)}`);
  }

  if (route.children?.length) {
    const childEntries = route.children.map(c => generateRouteEntry(c, root, indent + '  '));
    parts.push(`children: [\n${childEntries.join(',\n')}\n${indent}]`);
  }

  return `${indent}{ ${parts.join(', ')} }`;
}

function generateRoutesCode(routes: AngularRoute[], root: string): string {
  const routeEntries = routes.map(r => generateRouteEntry(r, root));

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

// ─── Plugin ───────────────────────────────────────────────────────────

export interface AngularPagesOptions {
  pagesDir?: string;
  modules?: AngularPagesModule[];
}

export function angularPages(options?: AngularPagesOptions): Plugin[] {
  let root: string;
  let pagesDir: string;
  let tree: RouteTree;
  let compiledParse: CompiledParsePath;

  const routeExtenders: ExtendRoutesCallback[] = [];
  const reloadCallbacks: (() => void)[] = [];
  const extraPlugins: Plugin[] = [];

  const ctx: AngularPagesModuleContext = {
    extendRoutes(callback) { routeExtenders.push(callback); },
    onPagesReload(callback) { reloadCallbacks.push(callback); },
  };

  for (const mod of options?.modules ?? []) {
    const plugin = mod(ctx);
    if (plugin) extraPlugins.push(plugin);
  }

  function treeOptions() {
    return {
      roots: [relative(root, pagesDir) + '/'],
      extensions: ['.ts'],
    };
  }

  function generateRoutes(): AngularRoute[] {
    let routes = toAngularRouter(tree);

    for (const extender of routeExtenders) {
      const result = extender(routes);
      if (result) routes = result;
    }

    return routes;
  }

  const mainPlugin: Plugin = {
    name: 'angular-pages',

    async configResolved(config) {
      root = config.root;
      pagesDir = options?.pagesDir ?? resolve(root, 'app/pages');
      const opts = treeOptions();
      compiledParse = compileParsePath(opts);

      const files = await glob('**/*.ts', {
        cwd: pagesDir,
        ignore: ['**/*.spec.ts', '**/*.test.ts'],
      });
      const filePaths = files.map(f => relative(root, resolve(pagesDir, f)));
      tree = buildTree(filePaths, opts);
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID;
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        const routes = generateRoutes();
        return generateRoutesCode(routes, root);
      }
    },

    configureServer(server) {
      server.watcher.add(pagesDir);

      const invalidate = () => {
        const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }
        for (const cb of reloadCallbacks) cb();
      };

      server.watcher.on('add', (path: string) => {
        const rel = relative(pagesDir, path);
        if (rel.startsWith('..') || !rel.endsWith('.ts')) return;
        addFile(tree, relative(root, path), compiledParse);
        invalidate();
      });

      server.watcher.on('unlink', (path: string) => {
        const rel = relative(pagesDir, path);
        if (rel.startsWith('..') || !rel.endsWith('.ts')) return;
        removeFile(tree, relative(root, path));
        invalidate();
      });
    },
  };

  return [mainPlugin, ...extraPlugins];
}
