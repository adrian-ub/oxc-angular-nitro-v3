import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve as resolvePath } from 'node:path';
import { glob } from 'tinyglobby';
import type { Plugin } from 'vite';

export interface AngularContentOptions {
  /** Directory containing content files (default: 'content') */
  contentDir?: string;
  /** Directory to auto-discover MDC components (default: 'app/components') */
  componentsDir?: string;
  /** Shiki theme (default: 'github-dark') */
  theme?: string;
  /** Extra remark plugins */
  remarkPlugins?: any[];
  /** Extra rehype plugins */
  rehypePlugins?: any[];
  /**
   * Additional MDC component tags (merged with auto-discovered ones).
   * Keys are element selectors used in markdown, values are { path, name }.
   */
  components?: Record<string, { path: string; name: string }>;
}

const VIRTUAL_ID = 'virtual:ng-content';
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;

const RENDERER_ID = 'virtual:ng-content/renderer';
const RESOLVED_RENDERER_ID = '\0virtual:ng-content-renderer.ts';

const CONTENT_PAGE_PREFIX = 'virtual:ng-content-page/';
const RESOLVED_PAGE_PREFIX = '\0' + CONTENT_PAGE_PREFIX;

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

/** Convert a content path to a PascalCase class name */
function toClassName(contentPath: string): string {
  return (contentPath || 'index')
    .replace(/[/\\]/g, '-')
    .replace(/(^|[-_.])(\w)/g, (_, __, c) => c.toUpperCase())
    + 'ContentPage';
}

/**
 * Escape Angular-special chars inside <pre> blocks (Shiki output).
 * Everything outside <pre> remains as valid Angular template HTML
 * so that MDC components (<app-greeting />) work.
 *
 * Code blocks are rendered via a property binding to avoid Angular
 * template parsing of {{ }}, @, {, etc.
 */
function escapeCodeBlocks(html: string): string {
  let result = '';
  let pos = 0;
  const preRegex = /<pre[^>]*>[\s\S]*?<\/pre>/g;
  let match: RegExpExecArray | null;
  let blockIndex = 0;
  const blocks: string[] = [];

  while ((match = preRegex.exec(html)) !== null) {
    result += html.slice(pos, match.index);
    blocks.push(match[0]);
    result += `<div [innerHTML]="__codeBlock${blockIndex}"></div>`;
    blockIndex++;
    pos = match.index + match[0].length;
  }

  result += html.slice(pos);
  return result;
}

/**
 * Extract code blocks from HTML and return them separately
 * so they can be stored as component properties.
 */
function extractCodeBlocks(html: string): string[] {
  const blocks: string[] = [];
  const preRegex = /<pre[^>]*>[\s\S]*?<\/pre>/g;
  let match: RegExpExecArray | null;

  while ((match = preRegex.exec(html)) !== null) {
    blocks.push(match[0]);
  }

  return blocks;
}

/**
 * Detect which registered MDC components are used in the HTML.
 */
function detectUsedComponents(
  html: string,
  registeredComponents: Record<string, { path: string; name: string }>
): string[] {
  const used: string[] = [];
  for (const tag of Object.keys(registeredComponents)) {
    const regex = new RegExp(`<${tag}[\\s/>]`, 'i');
    if (regex.test(html)) {
      used.push(tag);
    }
  }
  return used;
}

/**
 * Unwrap MDC component tags from <p> wrappers.
 * Markdown processors wrap standalone HTML in <p> tags, but block-level
 * Angular components inside <p> cause the browser parser to auto-close
 * the <p>, breaking hydration and reactivity.
 */
function unwrapMdcComponents(
  html: string,
  registeredComponents: Record<string, { path: string; name: string }>
): string {
  for (const tag of Object.keys(registeredComponents)) {
    const regex = new RegExp(
      `<p>\\s*(<${tag}[\\s>][\\s\\S]*?</${tag}>)\\s*</p>`,
      'gi'
    );
    html = html.replace(regex, '$1');
  }
  return html;
}

/**
 * Extract input property names from a component source file by static analysis.
 * Detects: `name = input()`, `name = input<T>()`, `name = input.required<T>()`,
 * `@Input() name`, `@Input('alias') name`.
 * Results are cached per tag.
 */
const inputMapCache = new Map<string, Map<string, string>>();

async function getInputMap(
  tag: string,
  component: { path: string; name: string },
  root: string
): Promise<Map<string, string>> {
  if (inputMapCache.has(tag)) return inputMapCache.get(tag)!;

  const inputMap = new Map<string, string>();

  try {
    const absPath = component.path.startsWith('/')
      ? resolvePath(root, component.path.slice(1))
      : component.path;
    const filePath = absPath.endsWith('.ts') ? absPath : absPath + '.ts';
    const source = await readFile(filePath, 'utf-8');

    // Signal inputs: name = input(), input<T>(), input.required<T>()
    const signalRe = /(\w+)\s*=\s*input(?:\s*\.\s*required)?(?:\s*<[^>]*>)?\s*\(/g;
    let m;
    while ((m = signalRe.exec(source))) {
      inputMap.set(m[1].toLowerCase(), m[1]);
    }

    // Decorator inputs: @Input() name or @Input('alias') name
    const decoratorRe = /@Input\([^)]*\)\s+(\w+)/g;
    while ((m = decoratorRe.exec(source))) {
      inputMap.set(m[1].toLowerCase(), m[1]);
    }
  } catch { /* file not found or unreadable — skip */ }

  inputMapCache.set(tag, inputMap);
  return inputMap;
}

/**
 * Convert plain HTML attributes on MDC components to Angular property bindings.
 * Rehype lowercases all HTML attributes, so `exampleInput` becomes `exampleinput`.
 * Uses reflectComponentType to recover original casing.
 *
 * Supports two conventions in markdown:
 *  - camelCase (lowercased by rehype): `exampleInput` → `exampleinput` → `[exampleInput]`
 *  - kebab-case: `example-input` → `[exampleInput]`
 */
async function bindMdcAttributes(
  html: string,
  registeredComponents: Record<string, { path: string; name: string }>,
  root: string
): Promise<string> {
  const SKIP_ATTRS = new Set(['class', 'style', 'id', 'hidden', 'title', 'slot', 'ngh', 'ng-version', 'ng-server-context']);

  for (const tag of Object.keys(registeredComponents)) {
    const inputMap = await getInputMap(tag, registeredComponents[tag], root);

    const tagRegex = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    html = html.replace(tagRegex, (fullMatch, attrsStr) => {
      if (!attrsStr) return fullMatch;
      const transformed = attrsStr.replace(
        /\s([a-z][a-z0-9-]*)="([^"]*)"/g,
        (_: string, attr: string, val: string) => {
          if (SKIP_ATTRS.has(attr)) return _;
          if (attr.startsWith('[') || attr.startsWith('(') || attr.startsWith('*') || attr.startsWith('#')) return _;
          // 1) kebab-case → camelCase  (example-input → exampleInput)
          // 2) lowercased → restore from inputMap  (exampleinput → exampleInput)
          let camelAttr = attr.includes('-')
            ? attr.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
            : (inputMap.get(attr) ?? attr);
          return ` [${camelAttr}]="'${val.replace(/'/g, "\\'")}'"`;
        }
      );
      return `<${tag}${transformed}>`;
    });
  }
  return html;
}

/**
 * Auto-discover Angular components from a directory.
 * Parses each .ts file to extract the selector and class name.
 */
async function scanComponents(
  componentsDir: string,
  root: string
): Promise<Record<string, { path: string; name: string }>> {
  const result: Record<string, { path: string; name: string }> = {};
  const files = await glob('**/*.ts', { cwd: componentsDir });

  for (const file of files) {
    const absPath = resolvePath(componentsDir, file);
    const source = await readFile(absPath, 'utf-8');

    const selectorMatch = source.match(/@Component\(\{[^}]*selector:\s*['"]([^'"]+)['"]/s);
    const classMatch = source.match(/export\s+class\s+(\w+)/);
    if (!selectorMatch || !classMatch) continue;

    const selector = selectorMatch[1];
    const name = classMatch[1];
    const importPath = '/' + relative(root, absPath).replace(/\.ts$/, '');

    result[selector] = { path: importPath, name };
  }

  return result;
}

/** Scan content directory for .md files */
async function scanContent(contentDir: string) {
  const files = await glob('**/*.md', { cwd: contentDir });
  return files.sort().map(file => {
    const path = file
      .replace(/\.md$/, '')
      .replace(/\/index$/, '')
      .replace(/^index$/, '');
    return { filePath: resolvePath(contentDir, file), path };
  });
}

export function angularContent(options?: AngularContentOptions): Plugin {
  let processor: Awaited<ReturnType<typeof createProcessor>> | null = null;
  let root: string;
  let contentDir: string;
  let componentsDirPath: string;
  let entries: { filePath: string; path: string }[] = [];
  const theme = options?.theme ?? 'github-dark';
  const remarkPlugins = options?.remarkPlugins ?? [];
  const rehypePlugins = options?.rehypePlugins ?? [];
  let components: Record<string, { path: string; name: string }> = {};

  return {
    name: 'angular-content',
    enforce: 'pre',

    async configResolved(config) {
      root = config.root;
      contentDir = options?.contentDir ?? resolvePath(root, 'content');
      componentsDirPath = resolvePath(root, options?.componentsDir ?? 'app/components');
      entries = await scanContent(contentDir);
      const discovered = await scanComponents(componentsDirPath, root);
      components = { ...discovered, ...options?.components };
    },

    async buildStart() {
      if (!processor) {
        processor = await createProcessor(theme, remarkPlugins, rehypePlugins);
      }
    },

    resolveId(id, importer) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      if (id === RENDERER_ID) return RESOLVED_RENDERER_ID;
      if (id.startsWith(CONTENT_PAGE_PREFIX)) return '\0' + id;

      // Resolve .md imports from content dir
      if (id.endsWith('.md')) {
        const resolved = id.startsWith('/')
          ? resolvePath(root, id.slice(1))
          : id.startsWith('.') && importer
            ? resolvePath(dirname(importer), id)
            : null;
        if (resolved && entries.some(e => e.filePath === resolved)) {
          return resolved;
        }
      }
    },

    async load(id) {
      // Prevent Vite from parsing raw .md content files as JS
      if (id.endsWith('.md') && entries.some(e => e.filePath === id)) {
        return 'export default {};';
      }

      // Generate a real Angular component for a content page
      if (id.startsWith(RESOLVED_PAGE_PREFIX)) {
        const contentPath = id.slice(RESOLVED_PAGE_PREFIX.length).replace(/\.ts$/, '');
        const entry = entries.find(e => e.path === contentPath);
        if (!entry) return null;

        this.addWatchFile(entry.filePath);

        const source = await readFile(entry.filePath, 'utf-8');
        const frontmatter = await extractFrontmatter(source);
        const result = await processor!.process(source);
        let html = String(result);

        // Detect MDC components used in the markdown HTML
        const usedTags = detectUsedComponents(html, components);
        const usedComponents = usedTags.map(tag => components[tag]);

        // Unwrap MDC components from <p> (prevents browser parser from
        // breaking DOM when block-level content is rendered inside <p>)
        html = unwrapMdcComponents(html, components);

        // Convert plain attributes on MDC components to Angular property bindings
        html = await bindMdcAttributes(html, components, root);

        // Extract code blocks before escaping (they'll become component properties)
        const codeBlocks = extractCodeBlocks(html);

        // Replace code blocks with property bindings
        html = escapeCodeBlocks(html);

        const className = toClassName(contentPath);
        const title = (frontmatter.title as string) ?? '';

        const importStatements = usedComponents
          .map(c => `import { ${c.name} } from '${c.path}';`)
          .join('\n');

        const importsArray = usedComponents.length
          ? `imports: [${usedComponents.map(c => c.name).join(', ')}],`
          : '';

        const metaJson = JSON.stringify({ title, frontmatter });

        const templateHtml = html.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

        // Generate code block properties with DomSanitizer to prevent stripping
        const needsSanitizer = codeBlocks.length > 0;
        const sanitizerImport = needsSanitizer
          ? `import { DomSanitizer } from '@angular/platform-browser';\nimport { inject } from '@angular/core';`
          : '';
        const sanitizerField = needsSanitizer
          ? '  _sanitizer = inject(DomSanitizer);'
          : '';
        const codeBlockProps = codeBlocks.map((block, i) => {
          const escaped = JSON.stringify(block);
          return `  __codeBlock${i} = this._sanitizer.bypassSecurityTrustHtml(${escaped});`;
        }).join('\n');

        return `
import { Component } from '@angular/core';
import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
${sanitizerImport}
${importStatements}

@Component({
  selector: '${(contentPath || 'index').replace(/\//g, '-')}-content',
  ${importsArray}
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: \`<article class="ng-content-page">${templateHtml}</article>\`,
})
export default class ${className} {
  static __md_meta = ${metaJson};
${sanitizerField}
${codeBlockProps}
}
`;
      }

      // Main virtual module: content index + injectContent + queryContent
      if (id === RESOLVED_VIRTUAL_ID) {
        const indexEntries = [];

        for (const entry of entries) {
          this.addWatchFile(entry.filePath);
          const source = await readFile(entry.filePath, 'utf-8');
          const fm = await extractFrontmatter(source);

          indexEntries.push({
            _id: entry.path,
            path: entry.path,
            title: (fm.title as string) ?? '',
            description: (fm.description as string) ?? '',
          });
        }

        const importStatements = entries.map((e, i) => {
          const importPath = `${CONTENT_PAGE_PREFIX}${e.path}.ts`;
          return `import __Content${i} from '${importPath}';`;
        });

        const mapEntries = entries.map((e, i) => {
          return `  '${e.path}': __Content${i}`;
        });

        return `
import { inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
${importStatements.join('\n')}

export const contentIndex = ${JSON.stringify(indexEntries, null, 2)};

const contentMap = {
${mapEntries.join(',\n')}
};

export function queryContent(path) {
  const component = contentMap[path];
  if (!component) return null;
  const meta = contentIndex.find(e => e.path === path);
  return meta ? { ...meta, _component: component } : null;
}

export function injectContent() {
  const route = inject(ActivatedRoute);
  return toSignal(
    route.url.pipe(
      map(segments => segments.map(s => s.path).join('/')),
      map(path => queryContent(path))
    ),
    { initialValue: null }
  );
}
`;
      }

      // ContentRenderer component - re-export from real file
      if (id === RESOLVED_RENDERER_ID) {
        return `export { ContentRenderer } from '${resolvePath(root, 'plugins/content-renderer')}';
`;
      }
    },

    configureServer(server) {
      server.watcher.add(contentDir);
      server.watcher.add(componentsDirPath);

      const reloadContent = async (path: string) => {
        const rel = relative(contentDir, path);
        if (rel.startsWith('..') || !rel.endsWith('.md')) return;

        entries = await scanContent(contentDir);
        inputMapCache.clear();

        // Invalidate main index module
        const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);

        // Invalidate the page component
        const contentPath = rel.replace(/\.md$/, '').replace(/\/index$/, '');
        const pageId = RESOLVED_PAGE_PREFIX + contentPath + '.ts';
        const pageMod = server.moduleGraph.getModuleById(pageId);
        if (pageMod) server.moduleGraph.invalidateModule(pageMod);

        server.ws.send({ type: 'full-reload' });
      };

      const reloadComponents = async (path: string) => {
        const rel = relative(componentsDirPath, path);
        if (rel.startsWith('..') || !rel.endsWith('.ts')) return;

        const discovered = await scanComponents(componentsDirPath, root);
        components = { ...discovered, ...options?.components };
        inputMapCache.clear();

        // Invalidate all content page modules so they pick up new components
        for (const entry of entries) {
          const pageId = RESOLVED_PAGE_PREFIX + entry.path + '.ts';
          const pageMod = server.moduleGraph.getModuleById(pageId);
          if (pageMod) server.moduleGraph.invalidateModule(pageMod);
        }
        const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);

        server.ws.send({ type: 'full-reload' });
      };

      server.watcher.on('add', (p) => { reloadContent(p); reloadComponents(p); });
      server.watcher.on('change', (p) => { reloadContent(p); reloadComponents(p); });
      server.watcher.on('unlink', (p) => { reloadContent(p); reloadComponents(p); });
    },
  };
}
