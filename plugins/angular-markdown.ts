import { readFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve as resolvePath } from 'node:path';
import { glob } from 'tinyglobby';
import type { Plugin } from 'vite';

export interface AngularMarkdownOptions {
  /** Directory to scan for .md page files — default: app/pages */
  pagesDir?: string;
  /** Shiki theme — default: 'github-dark' */
  theme?: string;
  /** Extra remark plugins */
  remarkPlugins?: any[];
  /** Extra rehype plugins */
  rehypePlugins?: any[];
}

const VIRTUAL_ROUTES_ID = 'virtual:angular-markdown-routes';
const RESOLVED_ROUTES_ID = '\0' + VIRTUAL_ROUTES_ID;

/** Convert filename to PascalCase component class name */
function toClassName(filename: string): string {
  return basename(filename)
    .replace(/\.md(\.ts)?$/, '')
    .replace(/\[\.\.\.([^\]]*)\]/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/(^|[-_.])(\w)/g, (_, __, c) => c.toUpperCase())
    + 'MdPage';
}

/**
 * Parse MDX-style import lines from markdown body.
 *
 * Supports:
 *   import { Foo } from './components/foo';
 *   import { Foo, Bar } from './components/foo';
 *   import Foo from './components/foo';
 */
const IMPORT_RE = /^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;

function parseBodyImports(source: string): {
  imports: { names: string[]; path: string }[];
  cleanedSource: string;
} {
  const lines = source.split('\n');
  const imports: { names: string[]; path: string }[] = [];
  const cleanedLines: string[] = [];
  let inFrontmatter = false;
  let frontmatterDone = false;
  let inCodeBlock = false;

  for (const line of lines) {
    // Track frontmatter block
    if (line.trim() === '---') {
      if (!frontmatterDone) {
        inFrontmatter = !inFrontmatter;
        if (!inFrontmatter) frontmatterDone = true;
      }
      cleanedLines.push(line);
      continue;
    }
    if (inFrontmatter) {
      cleanedLines.push(line);
      continue;
    }

    // Track fenced code blocks (``` or ~~~)
    if (line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      cleanedLines.push(line);
      continue;
    }

    // Only match imports outside code blocks
    if (!inCodeBlock) {
      const match = line.match(IMPORT_RE);
      if (match) {
        const names = match[1]
          ? match[1].split(',').map(n => n.trim()).filter(Boolean)
          : [match[2]];
        imports.push({ names, path: match[3] });
        continue;
      }
    }

    cleanedLines.push(line);
  }

  return { imports, cleanedSource: cleanedLines.join('\n') };
}

/** Escape HTML for embedding in a JS template literal string */
function escapeForTemplateLiteral(html: string): string {
  return html
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/** Create the unified markdown processor */
async function createProcessor(theme: string, remarkPlugins: any[], rehypePlugins: any[]) {
  const { unified } = await import('unified');
  const remarkParse = (await import('remark-parse')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const remarkFrontmatter = (await import('remark-frontmatter')).default;
  const remarkRehype = (await import('remark-rehype')).default;
  const rehypeRaw = (await import('rehype-raw')).default;
  const rehypeStringify = (await import('rehype-stringify')).default;
  const rehypeShiki = (await import('@shikijs/rehype')).default;

  let processor: any = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml']);

  for (const plugin of remarkPlugins) {
    processor = Array.isArray(plugin) ? processor.use(plugin[0], plugin[1]) : processor.use(plugin);
  }

  processor = processor
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeShiki, { theme });

  for (const plugin of rehypePlugins) {
    processor = Array.isArray(plugin) ? processor.use(plugin[0], plugin[1]) : processor.use(plugin);
  }

  return processor.use(rehypeStringify);
}

/** Extract YAML frontmatter from markdown source */
async function extractFrontmatter(source: string): Promise<Record<string, unknown>> {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const { parse } = await import('yaml');
    return parse(match[1]) ?? {};
  } catch {
    return {};
  }
}

async function generateAngularCode(
  mdFilePath: string,
  processor: ReturnType<typeof createProcessor> extends Promise<infer T> ? T : never,
): Promise<string> {
  const rawSource = await readFile(mdFilePath, 'utf-8');

  const frontmatter = await extractFrontmatter(rawSource);
  const title = (frontmatter.title as string) ?? '';

  // Parse and strip MDX-style imports from markdown body
  const { imports, cleanedSource } = parseBodyImports(rawSource);

  // Process markdown → HTML via unified pipeline
  const result = await processor.process(cleanedSource);
  const html = String(result);

  const className = toClassName(mdFilePath);
  const allComponentNames = imports.flatMap(i => i.names);

  const importStatements = imports
    .map(i => `import { ${i.names.join(', ')} } from '${i.path}';`)
    .join('\n');

  const importsArray = allComponentNames.length
    ? `imports: [${allComponentNames.join(', ')}],`
    : '';

  const metaJson = JSON.stringify({ title, frontmatter });

  // Use innerHTML to completely avoid Angular template escaping issues
  return `
import { Component, inject } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
${importStatements}

@Component({
  template: \`<div [innerHTML]="__html"></div>\`,
  ${importsArray}
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export default class ${className} {
  static __md_meta = ${metaJson};
  private __sanitizer = inject(DomSanitizer);
  __html = this.__sanitizer.bypassSecurityTrustHtml(\`${escapeForTemplateLiteral(html)}\`);
}
`;
}

/**
 * Converts a .md file path to an Angular route path.
 * Same conventions as angular-pages:
 *   docs.md → 'docs'
 *   blog/index.md → 'blog'
 *   blog/[id].md → 'blog/:id'
 */
function fileToRoute(filePath: string): string {
  let route = filePath
    .replace(/\.md$/, '')
    .replace(/\(([^)]+)\)[/\\]/g, '')
    .replace(/\[\.\.\.([^\]]*)\]/g, '**')
    .replace(/\[([^\]]+)\]/g, ':$1')
    .split('\\').join('/')
    .replace(/\/index$/, '').replace(/^index$/, '');
  return route;
}

async function scanMdPages(pagesDir: string) {
  const files = await glob('**/*.md', { cwd: pagesDir });
  return files.sort((a, b) => a.localeCompare(b)).map(file => ({
    filePath: resolvePath(pagesDir, file),
    route: fileToRoute(file),
  }));
}

function generateRoutesCode(pages: { filePath: string; route: string }[], root: string): string {
  const entries = pages.map(({ filePath, route }) => {
    const importPath = '/' + relative(root, filePath).split('\\').join('/');
    return `  { path: '${route}', loadComponent: () => import('${importPath}') }`;
  });

  return `export const routes = [\n${entries.join(',\n')}\n];\n`;
}

export function angularMarkdown(options?: AngularMarkdownOptions): Plugin {
  let processor: Awaited<ReturnType<typeof createProcessor>> | null = null;
  let root: string;
  let pagesDir: string;
  let mdPages: { filePath: string; route: string }[] = [];
  const theme = options?.theme ?? 'github-dark';
  const remarkPlugins = options?.remarkPlugins ?? [];
  const rehypePlugins = options?.rehypePlugins ?? [];

  return {
    name: 'angular-markdown',
    enforce: 'pre',

    async configResolved(config) {
      root = config.root;
      pagesDir = options?.pagesDir ?? resolvePath(root, 'app/pages');
      mdPages = await scanMdPages(pagesDir);
    },

    async buildStart() {
      if (!processor) {
        processor = await createProcessor(theme, remarkPlugins, rehypePlugins);
      }
    },

    resolveId(id, importer) {
      // Virtual routes module
      if (id === VIRTUAL_ROUTES_ID) return RESOLVED_ROUTES_ID;

      // Resolve .md imports → .md.ts virtual ID so oxc-angular processes them
      if (id.endsWith('.md')) {
        if (id.startsWith('/')) {
          return root + id + '.ts';
        }
        if (id.startsWith('.') && importer) {
          return resolvePath(dirname(importer), id) + '.ts';
        }
        return id + '.ts';
      }
    },

    async load(id) {
      // Generate route definitions for .md pages
      if (id === RESOLVED_ROUTES_ID) {
        return generateRoutesCode(mdPages, root);
      }

      // Load .md.ts virtual file
      if (!id.endsWith('.md.ts')) return;
      const mdPath = id.slice(0, -3);
      this.addWatchFile(mdPath);
      return generateAngularCode(mdPath, processor!);
    },

    configureServer(server) {
      server.watcher.add(pagesDir);

      const reloadRoutes = async (path: string) => {
        const rel = relative(pagesDir, path);
        if (rel.startsWith('..') || !rel.endsWith('.md')) return;

        mdPages = await scanMdPages(pagesDir);
        const mod = server.moduleGraph.getModuleById(RESOLVED_ROUTES_ID);
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
