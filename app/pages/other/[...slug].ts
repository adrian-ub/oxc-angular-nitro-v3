import { Component } from "@angular/core";
import { useRoute } from '../../utils/use-route';

@Component({
  template: `Other Slug: {{ route.params()['slug'] }}`
})
export default class OtherSlugPage {
  protected route = useRoute();
}
