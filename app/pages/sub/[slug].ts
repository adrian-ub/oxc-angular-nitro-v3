import { Component } from "@angular/core";
import { routeParam } from '../../utils/route-param';

@Component({
  template: `Sub Slug: {{ slug() }}`
})
export default class SubSlugPage {
  protected slug = routeParam('slug');
}
