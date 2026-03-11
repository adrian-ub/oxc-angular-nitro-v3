import { Component } from "@angular/core";
import { useRoute } from '../../utils/use-route';

@Component({
  template: `Sub Slug: {{ route.params()['slug'] }}`
})
export default class SubSlugPage {
  protected route = useRoute();
}
