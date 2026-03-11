import { Component } from '@angular/core';
import { ContentRenderer } from '#plugins/content-renderer';
import { queryContent } from 'virtual:ng-content';

@Component({
  imports: [ContentRenderer],
  template: `
    @if (page; as page) {
      <content-renderer [value]="page" />
    } @else {
      <p>Page not found</p>
    }
  `,
})
export default class ContentPage {
  page = queryContent('docs');
}
