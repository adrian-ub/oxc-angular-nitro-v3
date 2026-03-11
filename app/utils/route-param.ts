import { inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

/**
 * Reactive route parameter as a signal.
 *
 * Works for both named params (`[slug]` → `:slug`) and
 * catch-all params (`[...slug]` → `**`).
 *
 * Usage:
 *   protected slug = routeParam('slug');
 *
 * For catch-all routes the segments are joined with '/':
 *   /other/foo/bar → 'foo/bar'
 */
export function routeParam(name: string) {
  const route = inject(ActivatedRoute);

  return toSignal(
    route.url.pipe(
      map(() => {
        // Try named param first (e.g. :slug)
        const paramValue = route.snapshot.paramMap.get(name);
        if (paramValue !== null) {
          return paramValue;
        }
        // Fallback: catch-all route — join all URL segments
        return route.snapshot.url.map(s => s.path).join('/');
      })
    ),
    { initialValue: '' }
  );
}
