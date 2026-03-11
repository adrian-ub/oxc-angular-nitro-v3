import { computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  type ActivatedRouteSnapshot,
  NavigationEnd,
  type Params,
  Router,
} from '@angular/router';
import { filter, map, startWith } from 'rxjs';

export interface RouteInfo {
  /** Route params (reactive). Includes catch-all segments for `[...slug]` routes. */
  params: Signal<Params>;
  /** Query string params (reactive). */
  query: Signal<Params>;
  /** URL hash/fragment without `#` (reactive). */
  hash: Signal<string>;
  /** Full URL including query and hash (reactive). */
  fullPath: Signal<string>;
  /** URL pathname without query or hash (reactive). */
  path: Signal<string>;
  /** Custom data attached to the route record (reactive). */
  meta: Signal<Record<string, unknown>>;
  /** Unique name for the route record. */
  name: Signal<string | undefined>;
  /** Array of matched route snapshots from root to current (reactive). */
  matched: Signal<ActivatedRouteSnapshot[]>;
  /** Route location that was attempted before ending up on the current one. */
  redirectedFrom: Signal<string | undefined>;
}

/**
 * Must be called in an injection context (constructor, field initializer, or `runInInjectionContext`).
 *
 * @example
 * ```ts
 * // pages/blog/[slug].ts
 * const route = useRoute();
 * const slug = () => route.params().slug;    // reactive
 * const q    = () => route.query().search;   // ?search=…
 * ```
 *
 * @example
 * ```ts
 * // pages/docs/[...slug].ts  (catch-all)
 * const route = useRoute();
 * const slug = () => route.params().slug;    // 'a/b/c'
 * ```
 */
export function useRoute(): RouteInfo {
  const route = inject(ActivatedRoute);
  const router = inject(Router);

  // Params — merges named params with catch-all segments (via route data _catchAllParam)
  const params = toSignal(
    route.url.pipe(
      map(() => {
        const p: Params = { ...route.snapshot.params };
        const catchAllParam = route.snapshot.data['_catchAllParam'] as
          | string
          | undefined;
        if (catchAllParam) {
          p[catchAllParam] = route.snapshot.url
            .map((s) => s.path)
            .join('/');
        }
        return p;
      }),
    ),
    { initialValue: {} as Params },
  );

  const query = toSignal(route.queryParams, {
    initialValue: {} as Params,
  });

  const hash = toSignal(
    route.fragment.pipe(map((f) => f ?? '')),
    { initialValue: '' },
  );

  const meta = toSignal(
    route.data.pipe(map((d) => {
      const { _catchAllParam: _, ...rest } = d;
      return rest as Record<string, unknown>;
    })),
    { initialValue: {} as Record<string, unknown> },
  );

  const name = computed(
    () => route.snapshot.routeConfig?.path,
  );

  const matched = toSignal(
    route.url.pipe(
      map(() => {
        const snapshots: ActivatedRouteSnapshot[] = [];
        let snap: ActivatedRouteSnapshot | null = route.snapshot.root;
        while (snap) {
          snapshots.push(snap);
          snap = snap.firstChild;
        }
        return snapshots;
      }),
    ),
    { initialValue: [] as ActivatedRouteSnapshot[] },
  );

  const navEnd$ = router.events.pipe(
    filter((e): e is NavigationEnd => e instanceof NavigationEnd),
  );

  const redirectedFrom = toSignal(
    navEnd$.pipe(
      map((e) => e.url !== e.urlAfterRedirects ? e.url : undefined),
    ),
    { initialValue: undefined },
  );

  const fullPath = toSignal(
    navEnd$.pipe(
      map((e) => e.urlAfterRedirects),
      startWith(router.url),
    ),
    { initialValue: router.url },
  );

  const path = computed(() => {
    const fp = fullPath();
    const i = fp.search(/[?#]/);
    return i === -1 ? fp : fp.substring(0, i);
  });

  return { params, query, hash, fullPath, path, meta, name, matched, redirectedFrom };
}
