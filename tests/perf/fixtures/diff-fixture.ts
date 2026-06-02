/**
 * Code-generated fixtures for the diff-pipeline benches (T06). They build
 * `baseLines` / `currentLines` pairs that drive `HunkHelper.diff`,
 * `WordDiffHelper.lines`, and `DiffRenderHelper.render` exactly as the history
 * modal does on a version pick or a mode toggle.
 *
 * The diff cost is non-linear in the *shape* of the edit, not just the file
 * size (the underlying Myers diff is roughly O(N x D) in the number of
 * differences D), so each size is exercised in three shapes:
 * - `edit`: one contiguous hunk near the middle (the common single-block edit),
 * - `churn`: ten scattered single-line hunks spread across the file,
 * - `rewrite`: almost every line changed (worst case for the diff library).
 *
 * Lines carry a few words each so the word-level diff (`diffWords`) and the
 * inline word-span rendering have real intra-line work to do, not just a line
 * id. Fixtures are deterministic (no randomness) so the medians are
 * reproducible across runs, and nothing is committed as JSON: the arrays are
 * regenerated in-process on every run.
 */

/** The three file sizes, in line counts, spanning the small/medium/large curve. */
export const FIXTURE_SIZES = {
  small: {name: 'small', lines: 50},
  medium: {name: 'medium', lines: 400},
  large: {name: 'large', lines: 1000},
} as const;

/** A fixture size descriptor (name + line count). */
export type FixtureSize = (typeof FIXTURE_SIZES)[keyof typeof FIXTURE_SIZES];

/** The three edit shapes the diff pipeline is benched against. */
export type FixtureShape = 'edit' | 'churn' | 'rewrite';

/** All shapes, in the order the benches iterate them. */
export const FIXTURE_SHAPES: readonly FixtureShape[] = ['edit', 'churn', 'rewrite'] as const;

/** Number of scattered single-line hunks the `churn` shape produces. */
const CHURN_HUNKS = 10;

/**
 * A base/current line-array pair ready to feed the diff helpers.
 */
export interface DiffPair {
  baseLines: string[];
  currentLines: string[];
}

/**
 * Builds one base line with a stable, word-rich body so the word-level diff has
 * real segmentation work. The leading index keeps every line unique, which
 * stops the line-level diff from collapsing unrelated lines into a single
 * spurious match.
 *
 * @param {number} index - The 0-based line index
 * @return {string} The base line text
 */
function baseLine(index: number): string {
  return `line ${index}: the quick brown fox jumps over the lazy dog number ${index}`;
}

/**
 * Builds the changed counterpart of a base line: the same word-rich shape with
 * a couple of words swapped, so the line reads as a genuine modification (a
 * removed block paired with an added block) and the word diff finds both
 * unchanged and changed segments inside it.
 *
 * @param {number} index - The 0-based line index
 * @return {string} The changed line text
 */
function changedLine(index: number): string {
  return `line ${index}: the swift red fox leaps over the sleepy cat number ${index}`;
}

/**
 * Generates the base/current pair for a given size and shape.
 *
 * `edit` changes one contiguous block in the middle, `churn` changes ten lines
 * evenly spread across the file (each its own hunk because the surrounding
 * lines stay put), and `rewrite` changes every line except a few anchors so the
 * file is still recognisably the same file (avoiding a degenerate
 * full-replace-from-empty that the helpers special-case).
 *
 * @param {FixtureSize} size - The file size descriptor
 * @param {FixtureShape} shape - The edit shape
 * @return {DiffPair} The base/current line arrays
 */
export function buildPair(size: FixtureSize, shape: FixtureShape): DiffPair {
  const baseLines: string[] = Array.from({length: size.lines}, (_unused, index: number): string => baseLine(index));
  const currentLines: string[] = baseLines.slice();

  switch (shape) {
    case 'edit': {
      // One contiguous hunk of ~10% of the file (at least 3 lines) in the middle.
      const span: number = Math.max(3, Math.floor(size.lines * 0.1));
      const start: number = Math.floor((size.lines - span) / 2);

      for (let i: number = start; i < start + span; i++) {
        currentLines[i] = changedLine(i);
      }

      break;
    }
    case 'churn': {
      // Ten isolated single-line changes; the unchanged neighbours on both
      // sides keep each one its own hunk rather than merging into a block.
      const step: number = Math.max(2, Math.floor(size.lines / (CHURN_HUNKS + 1)));

      for (let h: number = 1; h <= CHURN_HUNKS; h++) {
        const at: number = Math.min(size.lines - 1, h * step);

        currentLines[at] = changedLine(at);
      }

      break;
    }
    case 'rewrite': {
      // Almost everything changes; keep every 13th line as an anchor so the
      // diff still aligns the file with itself instead of treating it as a
      // wholesale add/remove.
      for (let i: number = 0; i < size.lines; i++) {
        if (i % 13 !== 0) {
          currentLines[i] = changedLine(i);
        }
      }

      break;
    }
  }

  return {baseLines, currentLines};
}

/** The three benched helpers, used to pick an iteration count per cost class. */
export type DiffHelperKind = 'hunk' | 'word' | 'render';

/**
 * Iteration counts per helper and size, tuned so each label gets a stable
 * median while the whole file stays well under the 60s budget (AC4). The line
 * helpers (`hunk`, `word`) are microsecond-to-millisecond cheap and can afford
 * many iterations; `DiffRenderHelper.render` is orders of magnitude heavier
 * (it diffs, then builds DOM through jsdom), so it gets far fewer iterations,
 * scaling down sharply with size where a single near-total `rewrite` render
 * already costs hundreds of milliseconds.
 *
 * @param {DiffHelperKind} kind - The helper being benched
 * @param {FixtureSize} size - The file size descriptor
 * @return {number} The iteration count for `measure`
 */
export function itersFor(kind: DiffHelperKind, size: FixtureSize): number {
  if (kind === 'render') {
    switch (size.lines) {
      case FIXTURE_SIZES.small.lines:
        return 30;
      case FIXTURE_SIZES.medium.lines:
        return 8;
      default:
        return 3;
    }
  }

  switch (size.lines) {
    case FIXTURE_SIZES.small.lines:
      return 200;
    case FIXTURE_SIZES.medium.lines:
      return 50;
    default:
      return 10;
  }
}
