import '@angular/compiler';
import './app/styles.css';
import { renderApplication } from '@angular/platform-server';
import { reflectComponentType } from '@angular/core';
import { BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { createHead, transformHtmlTemplate } from "unhead/server";

import { App } from './app/app';
import { config } from './app/app.config.server';

import clientAssets from "./entry-client?assets=client";
import serverAssets from "./entry-server?assets=ssr";

const bootstrap = (context: BootstrapContext) =>
    bootstrapApplication(App, config, context);

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const assets = clientAssets.merge(serverAssets);

  const head = createHead();

  head.push({
    link: [
      ...assets.css.map((attrs: any) => ({ rel: "stylesheet", ...attrs })),
      ...assets.js.map((attrs: any) => ({ rel: "modulepreload", ...attrs })),
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
};

function htmlTemplate(): string {
  const selector = reflectComponentType(App)?.selector || 'app-root';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nitro + Angular</title>
</head>
<body>
  <${selector}></${selector}>
</body>
</html>`;
}

export default {
  fetch: handler,
};
