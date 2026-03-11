import { Component, input, signal } from '@angular/core';

@Component({
  selector: 'app-greeting',
  template: `
  <h1>Hello {{ name() }}</h1>
  <button (click)="changeName()">Change Name</button>
  <p>Example Input: {{ exampleInput() }}</p>
  <div><ng-content></ng-content></div>`,
})
export class GreetingComponent {
  name = signal('World');
  exampleInput = input();

  changeName() {
    this.name.set('Angular');
  }
}
