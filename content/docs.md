---
title: Hello from Markdown!
description: A markdown page rendered with Angular Content
---

# Hello from Markdown! 🎉

This page is written in **Markdown** and lives in the `content/` directory.

## Features

- ✅ Frontmatter support (YAML)
- ✅ Syntax highlighting via Shiki
- ✅ GFM tables, blockquotes, etc.
- ✅ MDC: use Angular components inside markdown

## MDC Component

This is a real Angular component rendered inside markdown:

<app-greeting exampleInput="Hello, MDC!">ng-content test</app-greeting>

## Code Example

```ts
import { Component } from '@angular/core';

@Component({
  template: `<h1>Hello {{ name }}</h1>`,
})
export class GreetingComponent {
  name = 'World';
}
```

## A table

| Feature   | Status |
| --------- | ------ |
| Markdown  | ✅     |
| Shiki     | ✅     |
| MDC       | ✅     |

> **Note:** This page uses MDC syntax — Angular components work directly in markdown!
