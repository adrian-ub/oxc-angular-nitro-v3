import { Component, inject, Injectable } from "@angular/core";

@Injectable()
export class SomeService {
  getValue() {
    return 'Some Value';
  }
}

@Component({
  template: `Without Export Default: {{ value }}`,
})
export class WithoutExportDefaultPage {
  protected value = inject(SomeService).getValue();
}

export default SomeService;
