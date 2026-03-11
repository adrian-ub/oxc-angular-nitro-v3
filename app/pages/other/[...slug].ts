import { Component } from "@angular/core";
import { routeParam } from '../../utils/route-param';

@Component({
  template: `Other Slug: {{ slug() }}`
})
export default class OtherSlugPage {
  protected slug = routeParam('slug');
}
