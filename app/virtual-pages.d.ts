declare module 'virtual:angular-pages' {
  import type { Routes } from '@angular/router';
  export const routes: Routes;
}

declare module 'virtual:naxt/app-config' {
  import type { ApplicationConfig } from '@angular/core';
  export const appConfig: ApplicationConfig;
}

declare module 'virtual:naxt/app-config-server' {
  import type { ApplicationConfig } from '@angular/core';
  export const config: ApplicationConfig;
}

declare module 'virtual:ng-content' {
  import type { Signal } from '@angular/core';

  export type { ContentMeta, ContentDocument } from '#plugins/content-types';

  export const contentIndex: import('#plugins/content-types').ContentMeta[];

  export function queryContent(path: string): import('#plugins/content-types').ContentDocument | null;

  export function injectContent(): Signal<import('#plugins/content-types').ContentDocument | null>;
}

declare module 'virtual:ng-content/renderer' {
  export { ContentRenderer } from '#plugins/content-renderer';
}

declare module 'virtual:ng-content-page/*' {
  import type { Type } from '@angular/core';
  const component: Type<unknown>;
  export default component;
}
