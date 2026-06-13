/**
 * Shared jsdom DOM-extension polyfill for the renderer test suites.
 *
 * Obsidian augments `HTMLElement.prototype` with `empty()` at runtime; jsdom
 * does not. `DomHelper.update` calls `empty()` before pasting parsed HTML in the
 * diff2html branch, so any jsdom test that drives a renderer must install the
 * polyfill first. This is the single source previously duplicated inline across
 * diff-render-helper.test.ts, folder-diff-renderer.test.ts,
 * folder-tree-component.test.ts, and perf/diff.perf.ts.
 *
 * Idempotent: it only installs `empty` when the prototype does not already carry
 * it, so calling it from multiple `beforeAll` hooks in one run is safe.
 */
export const installJsdomDomPolyfill = (): void => {
  if (!(HTMLElement.prototype as unknown as { empty?: () => void }).empty) {
    (HTMLElement.prototype as unknown as { empty: () => void }).empty = function emptyImpl(this: HTMLElement): void {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
    };
  }
};
