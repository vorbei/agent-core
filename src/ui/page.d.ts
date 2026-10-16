// A page over the side panel's shown view (src/ui/page.js), exported as agent-core/ui/page.

/** The page's head: back button, the view it came from, its title, optional controls. */
export function pageHeadMarkup(options: {
  title: string;
  from?: string;
  titleId?: string;
  back: { label: string; attrs?: string };
  controls?: string;
}): string;

/** Moves focus to an open page's title. */
export function focusPageTitle(page: Element | null | undefined): void;
