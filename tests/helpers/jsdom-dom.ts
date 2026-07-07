/**
 * Shared jsdom DOM-extension polyfill for the renderer and view test suites.
 *
 * Obsidian augments `HTMLElement.prototype` with helpers jsdom does not ship:
 * `empty()` (which `DomHelper.update` calls before pasting parsed HTML in the
 * diff2html branch) and `addClass()` (which an ItemView open path calls to tag
 * its `contentEl`). Any jsdom test that drives a renderer or a real view must
 * install this polyfill first. This is the single source previously duplicated
 * inline across the renderer suites (diff-render-helper.test.ts,
 * folder-diff-renderer.test.ts, folder-tree-component.test.ts, perf/diff.perf.ts)
 * and, for `addClass`, re-shimmed locally in recent-changes.view.test.ts.
 *
 * Idempotent: each augmentation is installed only when the prototype does not
 * already carry it, so calling it from multiple `beforeAll` hooks in one run is
 * safe.
 */
export const installJsdomDomPolyfill = (): void => {
  if (!(HTMLElement.prototype as unknown as { empty?: () => void }).empty) {
    (HTMLElement.prototype as unknown as { empty: () => void }).empty = function emptyImpl(this: HTMLElement): void {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
    };
  }

  if (!(HTMLElement.prototype as unknown as { addClass?: (cls: string) => void }).addClass) {
    (HTMLElement.prototype as unknown as { addClass: (cls: string) => void }).addClass = function addClassImpl(this: HTMLElement, cls: string): void {
      this.classList.add(cls);
    };
  }
};
