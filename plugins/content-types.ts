import type { Type } from '@angular/core';

export interface ContentMeta {
  _id: string;
  path: string;
  title: string;
  description: string;
}

export interface ContentDocument extends ContentMeta {
  _component: Type<unknown>;
}
