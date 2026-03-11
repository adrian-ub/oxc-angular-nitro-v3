import { Component, input } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import type { ContentDocument } from './content-types';

@Component({
  selector: 'content-renderer',
  imports: [NgComponentOutlet],
  template: '<ng-container *ngComponentOutlet="value()?._component ?? null" />',
})
export class ContentRenderer {
  value = input<ContentDocument>();
}
