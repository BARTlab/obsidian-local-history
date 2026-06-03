/**
 * @jest-environment jsdom
 */

import 'reflect-metadata';

import {beforeAll, describe, expect, it} from '@jest/globals';

import {DiffOutputFormatType, DiffViewMode} from '@/consts';
import {DiffRenderHelper} from '@/helpers/diff-render.helper';
import {HunkHelper} from '@/helpers/hunk.helper';
import {WordDiffHelper} from '@/helpers/word-diff.helper';
import type {DiffRenderMode, DiffRenderParams} from '@/types';

import {
  buildPair,
  type DiffPair,
  FIXTURE_SHAPES,
  FIXTURE_SIZES,
  type FixtureShape,
  type FixtureSize,
  itersFor,
} from './fixtures/diff-fixture';
import {assertWithinBaseline, measure} from './harness';

/**
 * Perf benches for the diff pipeline the history modal recomputes on every
 * version pick and every mode toggle, with no caching (T06). Three helpers are
 * gated across three file sizes x three edit shapes (27 labels total):
 * - `HunkHelper.diff`: line-level structured-patch hunks (zero context),
 * - `WordDiffHelper.lines`: the inline diff line list (line diff + pairing),
 * - `DiffRenderHelper.render`: the full DOM render entry that calls both helpers
 *   plus diff2html.
 *
 * The diff cost is non-linear in the edit shape, not just the size, so each
 * size is exercised as a single-block `edit`, a scattered `churn`, and a
 * near-total `rewrite` (see the fixture). The helpers are pure over their input
 * (hunk/word) or write into a caller-provided container (render); a single
 * fixed pair therefore holds steady across all `measure` iterations with no
 * per-iter rebuild folding fixture cost into the median.
 *
 * Runs under jsdom (overriding the perf project's default node env via the
 * docblock above) because `DiffRenderHelper.render` produces DOM. The render
 * bench writes into a *detached* container and discards the markup: the gate
 * locks the compute, not the paint, exactly as DECISIONS notes. Each `diff.*`
 * label records-only against the empty baseline and gates past the regression
 * budget once a number is recorded.
 */
describe('diff perf', () => {
  /**
   * Obsidian augments HTMLElement.prototype with `empty()` at runtime; jsdom
   * does not, and DomHelper.update calls it before pasting parsed HTML in the
   * diff2html branch. Polyfill the minimum the renderer touches, matching
   * tests/diff-render-helper.test.ts.
   */
  beforeAll((): void => {
    if (!(HTMLElement.prototype as unknown as {empty?: () => void}).empty) {
      (HTMLElement.prototype as unknown as {empty: () => void}).empty = function emptyImpl(this: HTMLElement): void {
        while (this.firstChild) {
          this.removeChild(this.firstChild);
        }
      };
    }
  });

  /**
   * Inert translator echoing its key, enough for the patch copy-button tooltip
   * and the copy notice text the renderer reads.
   */
  const translator = {t: (key: string): string => key};

  /**
   * The render bench measures one mode per label. The 3x3 (size x shape) grid
   * is mapped to render modes so the nine `diff.render.*` labels together cover
   * all four modes - patch, inline, line-by-line, and the heaviest
   * side-by-side. Measuring all four modes inside every label would blow the
   * 60s budget on the large fixtures (a single side-by-side render of a 1000
   * line rewrite costs seconds); one mode per label keeps the gate honest about
   * per-pick render cost while still exercising every mode somewhere in the
   * grid. The two diff2html modes (line/side) are the heaviest, so they are
   * pinned to the small and medium rows and the large row renders only the
   * lighter patch/inline modes, keeping every cell bounded.
   *
   * @param {FixtureSize} size - The file size for this label
   * @param {FixtureShape} shape - The edit shape for this label
   * @return {DiffRenderMode} The mode to render for this label
   */
  const modeFor = (size: FixtureSize, shape: FixtureShape): DiffRenderMode => {
    if (size.lines === FIXTURE_SIZES.small.lines) {
      // Small row (50 lines) is the only place the two heavy diff2html modes are
      // affordable: line-by-line and the heaviest side-by-side both render fast
      // enough here to gate without bloating the suite. patch covers the fourth
      // text mode.
      switch (shape) {
        case 'edit':
          return DiffViewMode.patch;
        case 'churn':
          return DiffOutputFormatType.line;
        default:
          return DiffOutputFormatType.side;
      }
    }

    // Medium and large rows render only the light text modes (inline word diff,
    // unified patch), so the diff2html cost - which is super-linear and reaches
    // seconds on a few hundred changed lines - never lands on a big fixture and
    // the whole file stays comfortably under the 60s budget. All four modes are
    // still covered across the grid via the small row above.
    return shape === 'churn' ? DiffViewMode.patch : DiffViewMode.inline;
  };

  /**
   * Builds a render parameter bundle for a detached container in the given mode.
   *
   * @param {DiffPair} pair - The base/current line arrays
   * @param {DiffRenderMode} mode - The diff mode to render
   * @param {HTMLElement} container - The detached container to render into
   * @return {DiffRenderParams} The full parameter bundle
   */
  const renderParams = (pair: DiffPair, mode: DiffRenderMode, container: HTMLElement): DiffRenderParams => ({
    baseLines: pair.baseLines,
    currentLines: pair.currentLines,
    lineBreak: '\n',
    mode,
    container,
    filePath: 'notes/bench.md',
    plugin: translator,
  });

  /**
   * Runs the full benchmark grid: for every (size, shape) pair, gate the three
   * helpers under their `diff.hunk.*`, `diff.word.*`, and `diff.render.*`
   * labels. Defined as `it` cases so a single failing label is isolated.
   */
  for (const size of Object.values(FIXTURE_SIZES) as FixtureSize[]) {
    for (const shape of FIXTURE_SHAPES as FixtureShape[]) {
      it(`hunk diff over the ${size.name} ${shape} fixture`, (): void => {
        const label = `diff.hunk.${size.name}.${shape}`;
        const pair: DiffPair = buildPair(size, shape);

        // Sanity: the edit really produces hunks, so the bench measures diff
        // work rather than the base === current short-circuit.
        expect(HunkHelper.diff(pair.baseLines, pair.currentLines).length).toBeGreaterThan(0);

        const median = measure(label, (): void => {
          HunkHelper.diff(pair.baseLines, pair.currentLines);
        }, itersFor('hunk', size, shape));

        expect(median).toBeGreaterThan(0);
        assertWithinBaseline(label, median);
      });

      it(`word diff over the ${size.name} ${shape} fixture`, (): void => {
        const label = `diff.word.${size.name}.${shape}`;
        const pair: DiffPair = buildPair(size, shape);
        const base: string = pair.baseLines.join('\n');
        const current: string = pair.currentLines.join('\n');

        // Sanity: the inline line list is non-empty, so the bench exercises the
        // line-diff + removed/added pairing path.
        expect(WordDiffHelper.lines(base, current).length).toBeGreaterThan(0);

        const median = measure(label, (): void => {
          WordDiffHelper.lines(base, current);
        }, itersFor('word', size, shape));

        expect(median).toBeGreaterThan(0);
        assertWithinBaseline(label, median);
      });

      it(`render over the ${size.name} ${shape} fixture`, (): void => {
        const label = `diff.render.${size.name}.${shape}`;
        const pair: DiffPair = buildPair(size, shape);
        const mode: DiffRenderMode = modeFor(size, shape);
        const container: HTMLDivElement = document.createElement('div');

        // The renderer writes into a detached container by design; the bench
        // gates the compute, not the paint. Assert the node never attaches.
        expect(container.parentNode).toBeNull();

        const result = DiffRenderHelper.render(renderParams(pair, mode, container));

        expect(result.hunks.length).toBeGreaterThan(0);
        expect(container.parentNode).toBeNull();

        const median = measure(label, (): void => {
          // One full render into the detached container, mirroring a single
          // version pick / mode toggle in the modal. The container is replaced
          // wholesale on every call, so re-rendering in place is faithful.
          DiffRenderHelper.render(renderParams(pair, mode, container));
        }, itersFor('render', size, shape));

        // Still detached after the loop: the bench never paints into the document.
        expect(container.parentNode).toBeNull();
        expect(median).toBeGreaterThan(0);
        assertWithinBaseline(label, median);
      });
    }
  }
});
