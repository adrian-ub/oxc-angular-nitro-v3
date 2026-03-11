import { Component, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected labelText = signal('Click me to call /api/hello')

  async callApi() {
     const res = await fetch("/api/hello");

     this.labelText.set(await res.text());
  }
}
