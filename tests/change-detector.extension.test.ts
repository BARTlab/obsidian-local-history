import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { type ChangeSpec, EditorState } from '@codemirror/state';

// The change detector imports Decoration from @codemirror/view at class-field
// init time. Stub the view layer so the engine loads under the node test
// environment without touching the DOM; computeIncrementalChanges never reads
// the decoration value.
jest.mock('@codemirror/view', () => ({
  Decoration: { none: {} },
}));

import { editorInfoField } from 'obsidian';
import type { StateField } from '@codemirror/state';
import { ChangeType } from '@/consts';
import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';
import { TOKENS } from '@/services/tokens';
import { FileSnapshot } from '@/snapshots/file.snapshot';

type ViewArg = ConstructorParameters<typeof ChangeDetectorExtension>[0];
type PluginArg = ConstructorParameters<typeof ChangeDetectorExtension>[1];
type UpdateArg = Parameters<ChangeDetectorExtension['update']>[0];

const positions = (snapshot: FileSnapshot, type: ChangeType): number[] =>
  snapshot
    .content.getChanges(type)
    .simplify()
    .map((change): number => change.getLine())
    .sort((a: number, b: number): number => a - b);

const removedTrackerCount = (snapshot: FileSnapshot): number =>
  snapshot.trackers.getTrackerLines().filter((line): boolean => line.isStateRemoved()).length;

/**
 * Applies one editor transaction to `currentDoc` and feeds the resulting
 * ChangeSet through the detector's public update() path (so the hash-skip guard
 * is exercised too). Returns the new document string for threading subsequent
 * steps. The snapshot's last state must already equal `currentDoc`.
 */
const step = (snapshot: FileSnapshot, currentDoc: string, changes: ChangeSpec): string => {
  const start: EditorState = EditorState.create({ doc: currentDoc });
  const tr = start.update({ changes });
  // Resolve services by token: the detector injects both SnapshotsService and
  // SettingsService. Intermediate-version capture is disabled here so these
  // engine assertions stay focused on change detection, not the timeline.
  const snapshotsService = { getOne: (): FileSnapshot => snapshot, forceUpdate: (): void => undefined };
  const settingsService = { value: (): unknown => false };
  const plugin = {
    get: (key: unknown): unknown => (key === TOKENS.settings ? settingsService : snapshotsService),
  };

  const ext = new ChangeDetectorExtension({ state: tr.state } as unknown as ViewArg, plugin as unknown as PluginArg);

  ext.update({
    docChanged: true,
    changes: tr.changes,
    startState: tr.startState,
    state: tr.state,
  } as unknown as UpdateArg);

  return tr.state.doc.toString();
};

const lineRange = (doc: string, n: number): { from: number; to: number } => {
  const line = EditorState.create({ doc }).doc.line(n);

  return { from: line.from, to: line.to };
};

describe('ChangeDetectorExtension single-line edits', () => {
  it('marks an edited line as changed', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const { from, to } = lineRange('a\nb\nc', 2);

    step(snapshot, 'a\nb\nc', { from, to, insert: 'B' });

    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
  });

  it('marks an in-line insertion (no new line) as a change of that line', () => {
    const snapshot = new FileSnapshot('a\nb');

    step(snapshot, 'a\nb', { from: lineRange('a\nb', 1).to, insert: 'X' });

    expect(positions(snapshot, ChangeType.changed)).toEqual([0]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
  });

  it('skips a transaction that leaves the content hash unchanged', () => {
    const snapshot = new FileSnapshot('a\nb');

    // Replace "a" with "a": docChanged is true but the content is identical.
    step(snapshot, 'a\nb', { from: lineRange('a\nb', 1).from, to: lineRange('a\nb', 1).to, insert: 'a' });

    expect(snapshot.content.getChangesLinesCount()).toBe(0);
  });
});

describe('ChangeDetectorExtension multi-line insert', () => {
  it('marks two pasted lines as added at a line boundary', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Paste "\nX\nY" at the end of line "a" -> a, X, Y, b, c.
    step(snapshot, 'a\nb\nc', { from: lineRange('a\nb\nc', 1).to, insert: '\nX\nY' });

    expect(positions(snapshot, ChangeType.added)).toEqual([1, 2]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
  });

  it('marks an insert and a separate edit in one transaction', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    step(snapshot, 'a\nb\nc', [
      { from: lineRange('a\nb\nc', 1).from, to: lineRange('a\nb\nc', 1).to, insert: 'A' },
      { from: lineRange('a\nb\nc', 3).to, insert: '\nX' },
    ]);

    expect(positions(snapshot, ChangeType.changed)).toEqual([0]);
    expect(positions(snapshot, ChangeType.added)).toEqual([3]);
  });
});

describe('ChangeDetectorExtension multi-line delete', () => {
  it('marks deleted lines as removed and shifts the tail up', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Delete lines "b" and "c" -> a, d.
    step(snapshot, 'a\nb\nc\nd', { from: lineRange('a\nb\nc\nd', 1).to, to: lineRange('a\nb\nc\nd', 3).to, insert: '' });

    expect(removedTrackerCount(snapshot)).toBe(2);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    // The surviving original "d" sits at index 1 with no change marker.
    expect(snapshot.trackers.findCurrentLine(1)?.isStateOriginal()).toBe(true);
  });
});

describe('ChangeDetectorExtension mid-line split and join', () => {
  /**
   * Regression guard: the suffix boundary must not pair with an old line the
   * prefix boundary already owns. When it did, a mid-line Enter (or a mid-line
   * multi-line paste/delete) left the tracker set one line out of sync and the
   * self-heal pass flooded every line below the edit with a `changed` marker.
   */
  it('pressing Enter mid-line marks only the split pair, not the tail', () => {
    const doc = 'a\nbcd\ne\nf';
    const snapshot = new FileSnapshot(doc);

    // Split "bcd" after "b" -> a, b, cd, e, f.
    step(snapshot, doc, { from: lineRange(doc, 2).from + 1, insert: '\n' });

    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([2]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    expect(snapshot.trackers.findCurrentLine(3)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(4)?.isStateOriginal()).toBe(true);
  });

  it('pressing Enter mid-line on an already-changed line keeps the tail clean', () => {
    const snapshot = new FileSnapshot('a\nbcd\ne\nf');

    // Edit line 2 first so it already carries a changed marker, then split it.
    const afterEdit = step(snapshot, 'a\nbcd\ne\nf', {
      from: lineRange('a\nbcd\ne\nf', 2).from,
      to: lineRange('a\nbcd\ne\nf', 2).to,
      insert: 'bxd',
    });

    step(snapshot, afterEdit, { from: lineRange(afterEdit, 2).from + 2, insert: '\n' });

    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([2]);
    expect(snapshot.trackers.findCurrentLine(3)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(4)?.isStateOriginal()).toBe(true);
  });

  it('joining two lines with Backspace marks only the joined line, not the tail', () => {
    const doc = 'a\nb\nc\nd';
    const snapshot = new FileSnapshot(doc);

    // Delete the newline between "b" and "c" -> a, bc, d.
    const joinFrom = lineRange(doc, 2).to;

    step(snapshot, doc, { from: joinFrom, to: joinFrom + 1, insert: '' });

    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(removedTrackerCount(snapshot)).toBe(1);
    expect(snapshot.trackers.findCurrentLine(2)?.isStateOriginal()).toBe(true);
  });

  it('splitting and re-joining a line converges back to a restored state', () => {
    const doc = 'a\nbcd\ne';
    const snapshot = new FileSnapshot(doc);
    const splitPos = lineRange(doc, 2).from + 1;

    const afterSplit = step(snapshot, doc, { from: splitPos, insert: '\n' });

    step(snapshot, afterSplit, { from: splitPos, to: splitPos + 1, insert: '' });

    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.restored)).toEqual([1]);
    expect(snapshot.trackers.findCurrentLine(2)?.isStateOriginal()).toBe(true);
  });

  it('pasting a multi-line block mid-line adds the new lines and keeps the tail', () => {
    const doc = 'a\nbcd\ne\nf';
    const snapshot = new FileSnapshot(doc);

    // Paste "X\nY\nZ" after "b" -> a, bX, Y, Zcd, e, f.
    step(snapshot, doc, { from: lineRange(doc, 2).from + 1, insert: 'X\nY\nZ' });

    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([2, 3]);
    expect(snapshot.trackers.findCurrentLine(4)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(5)?.isStateOriginal()).toBe(true);
  });

  it('deleting from mid-line to a later mid-line removes the swallowed lines only', () => {
    const doc = 'a\nbcd\nef\ngh\nz';
    const snapshot = new FileSnapshot(doc);

    // Delete from after "b" (line 2) to after "g" (line 4) -> a, bh, z.
    step(snapshot, doc, {
      from: lineRange(doc, 2).from + 1,
      to: lineRange(doc, 4).from + 1,
      insert: '',
    });

    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(removedTrackerCount(snapshot)).toBe(2);
    expect(snapshot.trackers.findCurrentLine(2)?.isStateOriginal()).toBe(true);
  });
});

describe('ChangeDetectorExtension restore', () => {
  it('marks a line restored when its content returns to the original', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    const afterEdit: string = step(snapshot, 'a\nb\nc', {
      from: lineRange('a\nb\nc', 2).from,
      to: lineRange('a\nb\nc', 2).to,
      insert: 'B',
    });

    step(snapshot, afterEdit, {
      from: lineRange(afterEdit, 2).from,
      to: lineRange(afterEdit, 2).to,
      insert: 'b',
    });

    expect(positions(snapshot, ChangeType.restored)).toEqual([1]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
  });

  it('keeps line mapping correct after delete-then-retype of a line', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Delete the whole line "b" content, then retype it.
    const afterDelete: string = step(snapshot, 'a\nb\nc', {
      from: lineRange('a\nb\nc', 2).from,
      to: lineRange('a\nb\nc', 2).to,
      insert: '',
    });

    step(snapshot, afterDelete, {
      from: lineRange(afterDelete, 2).from,
      to: lineRange(afterDelete, 2).to,
      insert: 'b',
    });

    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    expect(snapshot.trackers.findCurrentLine(1)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(2)?.isStateOriginal()).toBe(true);
  });

  it('keeps the removed anchor when a different line is typed at its position', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Delete the whole line "b" including its newline: an anchor appears.
    const afterDelete: string = step(snapshot, 'a\nb\nc\nd', {
      from: lineRange('a\nb\nc\nd', 2).from,
      to: lineRange('a\nb\nc\nd', 3).from,
      insert: '',
    });

    expect(positions(snapshot, ChangeType.removed)).toEqual([1]);

    // Enter at the anchor spot, then type unrelated content there. The anchor
    // must survive: the deleted original was not brought back, so folding the
    // removal into a "changed" line silently loses the deletion record.
    const afterEnter: string = step(snapshot, afterDelete, { from: lineRange(afterDelete, 1).to, insert: '\n' });

    step(snapshot, afterEnter, { from: lineRange(afterEnter, 2).from, insert: 'fresh' });

    expect(positions(snapshot, ChangeType.added)).toEqual([1]);
    expect(positions(snapshot, ChangeType.removed)).toHaveLength(1);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
  });

  it('folds the anchor back when undo re-inserts a modified line as it was before deletion', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Edit line 2 first, so its content diverges from the baseline.
    const afterEdit: string = step(snapshot, 'a\nb\nc\nd', {
      from: lineRange('a\nb\nc\nd', 2).from,
      to: lineRange('a\nb\nc\nd', 2).to,
      insert: 'B!',
    });

    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);

    // Delete the modified line entirely: the anchor records the deletion.
    const afterDelete: string = step(snapshot, afterEdit, {
      from: lineRange(afterEdit, 2).from,
      to: lineRange(afterEdit, 3).from,
      insert: '',
    });

    expect(positions(snapshot, ChangeType.removed)).toEqual([1]);

    // Ctrl+Z: one transaction re-inserting the line with its PRE-DELETION
    // content (not the baseline one). The anchor must fold back and the line
    // must return with its previous "changed" marker, not stay a brand-new
    // added line next to a stale removal record.
    step(snapshot, afterDelete, { from: lineRange(afterDelete, 2).from, insert: 'B!\n' });

    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
  });

  it('restores the anchor cleanly when the deleted line is re-inserted verbatim', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    const afterDelete: string = step(snapshot, 'a\nb\nc\nd', {
      from: lineRange('a\nb\nc\nd', 2).from,
      to: lineRange('a\nb\nc\nd', 3).from,
      insert: '',
    });

    expect(positions(snapshot, ChangeType.removed)).toEqual([1]);

    // One transaction re-inserting the exact deleted line (paste / undo path).
    step(snapshot, afterDelete, { from: lineRange(afterDelete, 1).to, insert: '\nb' });

    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
  });
});

describe('ChangeDetectorExtension line replacement (off-by-one regression)', () => {
  // A block of lines replaced by a different number of lines is treated as
  // delete + insert, consistent with the engine's pure-delete and pure-paste
  // behavior: the destroyed originals are removed and the replacements are
  // added, instead of mismapping survivors as "changed".
  it('maps a 2-line block replaced by 3 lines as remove + add', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Replace lines "b" and "c" with "X\nY\nZ" -> a, X, Y, Z, d.
    step(snapshot, 'a\nb\nc\nd', {
      from: lineRange('a\nb\nc\nd', 2).from,
      to: lineRange('a\nb\nc\nd', 3).to,
      insert: 'X\nY\nZ',
    });

    // "a" and "d" are untouched originals; the three middle lines are new and
    // the two original middle lines are gone.
    expect(snapshot.trackers.findCurrentLine(0)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(4)?.isStateOriginal()).toBe(true);
    expect(positions(snapshot, ChangeType.added)).toEqual([1, 2, 3]);
    expect(removedTrackerCount(snapshot)).toBe(2);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(positions(snapshot, ChangeType.restored)).toEqual([]);
  });
});

describe('ChangeDetectorExtension removed-anchor clamping', () => {
  // A multi-line original file replaced by fewer lines (select-all, then type a
  // single line) is a delete + insert where the removed count far exceeds the
  // inserted count. Several doomed originals stay current while the first ones
  // are removed, so the clamp must reach the final surviving last line. Before
  // the fix the early removed anchors orphaned past the last real line and the
  // removed gutter rendered a marker above the document title.
  it('keeps every removed anchor on a real line when the whole doc shrinks', () => {
    const snapshot = new FileSnapshot('o1\no2\no3\no4\no5');

    // Replace the whole document content with a single line "Z".
    const doc = 'o1\no2\no3\no4\no5';

    step(snapshot, doc, {
      from: 0,
      to: lineRange(doc, 5).to,
      insert: 'Z',
    });

    const last: number = Math.max(
      ...snapshot.trackers.getTrackerLines()
        .filter((line): boolean => line.existedInCurrent)
        .map((line): number => line.currentPosition),
    );

    snapshot.trackers.getTrackerLines()
      .filter((line): boolean => line.isStateRemoved())
      .forEach((line): void => {
        expect(line.removedAtPosition).toBeGreaterThanOrEqual(0);
        expect(line.removedAtPosition).toBeLessThanOrEqual(last);
      });

    [...snapshot.content.getChanges().keys()]
      .filter((key): key is number => typeof key === 'number')
      .forEach((key: number): void => {
        expect(key).toBeGreaterThanOrEqual(0);
        expect(key).toBeLessThanOrEqual(last);
      });
  });
});

describe('ChangeDetectorExtension removed-onto-added collapse at the document top', () => {
  // Add new lines below an original line, then delete the original from the top
  // with Del. The deleted original is removed at index 0 while the first added
  // line shifts up into index 0, so the change map carries both `added` and
  // `removed` on index 0. The model state is legitimate (a line was added there
  // and the original above it is gone); the line-mode renderer is responsible
  // for not stacking a removed marker onto the added bar (see gutter-bar).
  // This pins the anchor collision so a model-boundary change cannot silently
  // re-orphan the removed anchor off a real line.
  it('keeps the collapsed removed anchor on index 0, not past the last real line', () => {
    const snapshot = new FileSnapshot('start');

    // Add three lines below "start": start, A, B, C.
    const afterAdd: string = step(snapshot, 'start', { from: lineRange('start', 1).to, insert: '\nA\nB\nC' });

    // Del at the top removes the original "start": A, B, C remain.
    step(snapshot, afterAdd, { from: lineRange(afterAdd, 1).from, to: lineRange(afterAdd, 2).from, insert: '' });

    const last: number = Math.max(
      ...snapshot.trackers.getTrackerLines()
        .filter((line): boolean => line.existedInCurrent)
        .map((line): number => line.currentPosition),
    );

    // Every removed anchor stays on a real line (>= 0 and <= last current line).
    snapshot.trackers.getTrackerLines()
      .filter((line): boolean => line.isStateRemoved())
      .forEach((line): void => {
        expect(line.removedAtPosition).toBeGreaterThanOrEqual(0);
        expect(line.removedAtPosition).toBeLessThanOrEqual(last);
      });

    // No change-map key escapes the real line range.
    [...snapshot.content.getChanges().keys()]
      .filter((key): key is number => typeof key === 'number')
      .forEach((key: number): void => {
        expect(key).toBeGreaterThanOrEqual(0);
        expect(key).toBeLessThanOrEqual(last);
      });

    // Index 0 carries both the added line and the collapsed removed anchor.
    const top = snapshot.content.getChanges().get(0);

    expect(top?.has(ChangeType.added)).toBe(true);
    expect(top?.has(ChangeType.removed)).toBe(true);
  });
});

describe('ChangeDetectorExtension prev-state desync', () => {
  // The old-document side of a ChangeSet (fromA/toA) must be mapped against the
  // editor state those positions index into, i.e. update.startState. Earlier the
  // engine mapped them against the snapshot's cached state, which the weak hash
  // guard (TextHelper.hash, abs of a 32-bit rolling hash) can leave stale after a
  // skipped update. The fix derives `prev` from update.startState so mapping no
  // longer depends on the cached state staying in sync.
  it('maps the old-document side from update.startState, not a stale cached state', () => {
    const snapshot = new FileSnapshot('a\nb\nc\nd');

    // Simulate the desync: a prior update was hash-skipped, so the cached state
    // no longer mirrors the editor doc (here it has a different line layout).
    // With prev sourced from this stale cache, lineAt(toA) would collapse the
    // removed range to zero lines and drop the deletion entirely.
    snapshot.content.updateState(['aaaaaa', 'x']);

    // Delete lines "b" and "c": a, b, c, d -> a, d.
    step(snapshot, 'a\nb\nc\nd', {
      from: lineRange('a\nb\nc\nd', 1).to,
      to: lineRange('a\nb\nc\nd', 3).to,
      insert: '',
    });

    expect(removedTrackerCount(snapshot)).toBe(2);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    // The surviving original "d" sits at index 1 with no change marker.
    expect(snapshot.trackers.findCurrentLine(1)?.isStateOriginal()).toBe(true);
  });

  it('keeps line mapping correct across a rapid edit/undo sequence', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    // Edit line "b" twice, then undo back to the original content step by step.
    const s1: string = step(snapshot, 'a\nb\nc', {
      from: lineRange('a\nb\nc', 2).from,
      to: lineRange('a\nb\nc', 2).to,
      insert: 'B',
    });

    const s2: string = step(snapshot, s1, {
      from: lineRange(s1, 2).from,
      to: lineRange(s1, 2).to,
      insert: 'BB',
    });

    const s3: string = step(snapshot, s2, {
      from: lineRange(s2, 2).from,
      to: lineRange(s2, 2).to,
      insert: 'B',
    });

    step(snapshot, s3, {
      from: lineRange(s3, 2).from,
      to: lineRange(s3, 2).to,
      insert: 'b',
    });

    // Mapping never drifts off line index 1, and the round trip ends restored.
    expect(positions(snapshot, ChangeType.restored)).toEqual([1]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
  });
});

describe('ChangeDetectorExtension CRLF normalization', () => {
  // The editor surface must split content on /\r?\n/ rather than the CodeMirror
  // `state.lineBreak` convention, so a CRLF document does not leak a trailing
  // `\r` into the tracker (which would corrupt change content and equality).
  it('records an edited CRLF line without a trailing carriage return', () => {
    const doc = 'a\r\nb\r\nc';
    const snapshot = new FileSnapshot(doc, '\r\n');
    const { from, to } = lineRange(doc, 2);

    step(snapshot, doc, { from, to, insert: 'B' });

    const edited = snapshot.trackers.findCurrentLine(1);

    expect(edited?.current).toBe('B');
    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
  });

  it('keeps LF behaviour unchanged for a plain edit', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const { from, to } = lineRange('a\nb\nc', 2);

    step(snapshot, 'a\nb\nc', { from, to, insert: 'B' });

    const edited = snapshot.trackers.findCurrentLine(1);

    expect(edited?.current).toBe('B');
    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
  });
});

describe('ChangeDetectorExtension mixed line endings', () => {
  // A file mixing '\r\n' with a lone '\n' desyncs the baseline from the editor
  // when the baseline is split on the single '\r\n' convention: the last line
  // gets no tracker, so an edit to it is lost and the self-heal pass falsely
  // marks an untouched neighbour. Splitting the baseline on /\r?\n/ (as the
  // detector already does) keeps the two line sets aligned.
  it('tracks an edit on the line after a lone LF and spares its neighbour', () => {
    const doc = 'a\r\nb\nc';
    const snapshot = new FileSnapshot(doc, '\r\n');

    // The baseline holds a tracker for every real line, including the last.
    expect(snapshot.trackers.findCurrentLine(2)?.current).toBe('c');

    // Append '!' to the third line ('c').
    step(snapshot, doc, { from: lineRange(doc, 3).to, insert: '!' });

    const edited = snapshot.trackers.findCurrentLine(2);

    expect(edited?.current).toBe('c!');
    // Only the edited line is marked; line 'b' (index 1) is untouched.
    expect(positions(snapshot, ChangeType.changed)).toEqual([2]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
  });
});

describe('ChangeDetectorExtension empty-boundary-line rescue', () => {
  // A pure insertion that lands at the start of an empty boundary line (most
  // commonly the trailing empty line of a doc that ends with `\n`) reads as
  // `prefixShared=false`, `suffixShared=false` by the byte-length checks
  // because the empty line has zero length in both docs. Without the rescue,
  // the empty line is treated as deleted core and the inserted content's last
  // (preserved) line is treated as new core, leaving a phantom `removed`
  // anchor at the boundary and breaking later `findRemovedAt` lookups.

  it('pastes a multi-line block at the trailing empty line without phantom markers', () => {
    // Initial doc ends with `\n`, so it has a trailing empty line at index 1.
    const initial = 'header\n';
    const snapshot = new FileSnapshot(initial);
    const block = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n';

    step(snapshot, initial, {
      from: lineRange(initial, 2).from,
      to: lineRange(initial, 2).from,
      insert: block,
    });

    // The four table rows are the only added lines; the empty trailing line
    // is preserved at its new position (index 5), not re-created.
    expect(positions(snapshot, ChangeType.added)).toEqual([1, 2, 3, 4]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(removedTrackerCount(snapshot)).toBe(0);
    expect(snapshot.trackers.findCurrentLine(5)?.isStateOriginal()).toBe(true);
  });

  it('delete-then-paste of an identical multi-line block ends clean', () => {
    // Pasting then deleting then re-pasting the same content should leave the
    // file in its original tracker state. Previously the phantom `removed`
    // anchor from the first paste corrupted the `findRemovedAt` lookup on the
    // re-paste, producing spurious `added`/`removed` markers at the boundary.
    const initial = 'header\n';
    const snapshot = new FileSnapshot(initial);
    const block = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n';

    const afterPaste: string = step(snapshot, initial, {
      from: lineRange(initial, 2).from,
      to: lineRange(initial, 2).from,
      insert: block,
    });

    const afterDelete: string = step(snapshot, afterPaste, {
      from: lineRange(afterPaste, 2).from,
      to: lineRange(afterPaste, 6).from,
      insert: '',
    });

    step(snapshot, afterDelete, {
      from: lineRange(afterDelete, 2).from,
      to: lineRange(afterDelete, 2).from,
      insert: block,
    });

    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(positions(snapshot, ChangeType.added)).toEqual([1, 2, 3, 4]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
  });

  it('pure-deletion ending at an empty trailing line preserves that line', () => {
    // Deleting the only "content" lines from a doc whose trailing empty line
    // must survive: without the rescue, the trailing empty line in NEW was
    // treated as a brand-new added line, which both painted an `added` mark
    // and left the original trailing-empty tracker orphaned.
    const initial = 'header\nT0\nT1\n';
    const snapshot = new FileSnapshot(initial);

    step(snapshot, initial, {
      from: lineRange(initial, 2).from,
      to: lineRange(initial, 4).from,
      insert: '',
    });

    // T0 and T1 are gone (collapsed onto the same anchor as the doc shrinks);
    // the trailing empty line stays as the original tracker at index 1 with
    // no spurious `added` mark.
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(removedTrackerCount(snapshot)).toBe(2);
    expect(snapshot.trackers.findCurrentLine(1)?.isStateOriginal()).toBe(true);
  });

  it('insert without a trailing newline still modifies the empty line in place', () => {
    // The rescue must NOT fire when the inserted content has no trailing `\n`:
    // there, the empty boundary line genuinely becomes the new content, and
    // the in-place edit path (mark the line as changed) is the right answer.
    const snapshot = new FileSnapshot('header\n');

    step(snapshot, 'header\n', {
      from: lineRange('header\n', 2).from,
      to: lineRange('header\n', 2).from,
      insert: 'X',
    });

    // Line 1 (was empty) is now 'X' and is marked as changed; no added marker.
    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
  });
});

describe('ChangeDetectorExtension tracker self-heal', () => {
  // A tracker whose `current` field has drifted from the actual doc line at
  // its currentPosition (regardless of how it got there: compound transactions,
  // hash-collision skip of a prior update, restoreOrAddTracker resurrecting a
  // stale anchor, etc.) must be reconciled on the next change so a stale
  // anchor cannot keep a wrong `changed` marker on a line the user didn't
  // touch. Without the self-heal pass the wrong marker persists until the
  // user resets the baseline.

  it('clears a stale `changed` marker on a line that is in fact unchanged', () => {
    const snapshot = new FileSnapshot('11111\nbody\ntail');

    // Forge the drift: tracker[0]'s `current` claims '1' while the doc line
    // is '11111'. This is the persisted symptom from the user-reported bug.
    snapshot.trackers.getTrackerLines()[0]!.current = '1';
    snapshot.trackers.getTrackerLines()[0]!.contentSameOriginal = false;
    snapshot.trackers.getTrackerLines()[0]!.changeAtPosition = 0;

    snapshot.updateChanges();
    expect(positions(snapshot, ChangeType.changed)).toContain(0);

    // Touch an unrelated line elsewhere in the doc; the self-heal must run
    // and reconcile tracker[0] with the real content.
    step(snapshot, '11111\nbody\ntail', {
      from: lineRange('11111\nbody\ntail', 3).to,
      insert: '!',
    });

    expect(snapshot.trackers.getTrackerLines()[0]!.current).toBe('11111');
    expect(snapshot.trackers.getTrackerLines()[0]!.contentSameOriginal).toBe(true);
    expect(positions(snapshot, ChangeType.changed)).not.toContain(0);
  });
});

describe('ChangeDetectorExtension scale (hot path)', () => {
  // Pastes then deletes a large block in single transactions. The old tracker
  // hot path sorted and rebuilt an ArrayMap for every shifted line (and per
  // findCurrentLine), which is O(n^2 log n) on a block this size; the indexed
  // path is linear per line. The result must stay correct and finish well under
  // the budget below, which the previous code would blow past.
  it('handles a 5000-line paste and delete correctly and fast', () => {
    const lineCount = 5000;
    const base = 'a\nb';
    const snapshot = new FileSnapshot(base);
    const pasted: string = Array.from({ length: lineCount }, (_value, i: number): string => `line ${i}`).join('\n');

    const started: number = Date.now();

    // Paste the block after the first line, then delete exactly that block.
    const afterPaste: string = step(snapshot, base, { from: lineRange(base, 1).to, insert: `\n${pasted}` });

    step(snapshot, afterPaste, {
      from: lineRange(afterPaste, 1).to,
      to: lineRange(afterPaste, 1 + lineCount).to,
      insert: '',
    });

    const elapsed: number = Date.now() - started;

    // The pasted lines never existed in the original, so deleting them leaves no
    // trace: the document is back to its original two original lines.
    expect(snapshot.content.getChangesLinesCount()).toBe(0);
    expect(snapshot.trackers.getTrackerLines().filter((line): boolean => line.existedInCurrent)).toHaveLength(2);
    expect(snapshot.trackers.findCurrentLine(0)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(1)?.isStateOriginal()).toBe(true);

    // Generous bound to stay stable on slow CI while still catching a regression
    // to the per-line sort/copy path (which runs into tens of seconds here).
    expect(elapsed).toBeLessThan(8000);
  }, 30000);
});

describe('ChangeDetectorExtension nested cell editors', () => {
  // Typing in a Live Preview table cell fires the detector inside the cell's
  // own editor, whose doc holds only the cell text. Without the guard that
  // edit was mapped onto file line 0 (phantom marker on line 1 of the note)
  // and updateState collapsed the tracked content to the single cell line,
  // from where a bogus one-line version could reach the stored history.
  it('ignores updates coming from a nested cell editor', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    // The cell's mini-document: one line of cell text, then a typed character.
    const start: EditorState = EditorState.create({ doc: 'cell' });
    const tr = start.update({ changes: { from: 4, insert: 'x' } });

    const snapshotsService = { getOne: (): FileSnapshot => snapshot, forceUpdate: (): void => undefined };
    const settingsService = { value: (): unknown => false };
    const plugin = {
      get: (key: unknown): unknown => (key === TOKENS.settings ? settingsService : snapshotsService),
    };

    // A view whose state carries an editorInfoField pointing at a foreign
    // outer view: the shape Obsidian gives a table-cell sub-editor. The
    // runtime field is the jest stub (StateField<unknown>); retype the real
    // obsidian declaration to match so init can return a plain test double.
    const infoField = editorInfoField as unknown as StateField<unknown>;
    const nestedView = {
      dom: { closest: (): Element | null => null },
      state: EditorState.create({
        doc: 'cellx',
        extensions: [infoField.init((): unknown => ({ editor: { cm: {} } }))],
      }),
    };

    const ext = new ChangeDetectorExtension(
      nestedView as unknown as ViewArg,
      plugin as unknown as PluginArg,
    );

    ext.update({
      view: nestedView,
      docChanged: true,
      changes: tr.changes,
      startState: tr.startState,
      state: tr.state,
    } as unknown as UpdateArg);

    // The file snapshot is untouched: no phantom change on line 0 and the
    // tracked state still mirrors the file, not the cell.
    expect(snapshot.content.getChangesLinesCount()).toBe(0);
    expect(snapshot.content.getLastStateLines()).toEqual(['a', 'b', 'c']);
  });
});

describe('ChangeDetectorExtension multi-range doomed-capture coordinates', () => {
  // In one transaction with several ranges, each earlier range's add/remove
  // shifts the tracker set toward the final document. The doomed-capture loop
  // resolves old-document line numbers, so without offsetting by the running
  // line delta a later range records the wrong originals as removed and the
  // self-heal pass marks an untouched survivor as changed.
  it('records the destroyed originals, not shifted survivors, for a later range', () => {
    const doc = 'aaa\nbbb\nccc\nddd\neee';
    const snapshot = new FileSnapshot(doc);

    // One transaction: insert "XXX" at the top and delete whole lines ccc, ddd
    // -> XXX, aaa, bbb, eee. The deletion range is processed after the insert
    // has already pushed every tracker down by one line.
    step(snapshot, doc, [
      { from: lineRange(doc, 1).from, insert: 'XXX\n' },
      { from: lineRange(doc, 3).from, to: lineRange(doc, 5).from, insert: '' },
    ]);

    const removedOriginals: (string | null)[] = snapshot.trackers.getTrackerLines()
      .filter((line): boolean => line.isStateRemoved())
      .map((line): string | null => line.original)
      .sort();

    expect(removedOriginals).toEqual(['ccc', 'ddd']);

    const survivor = snapshot.trackers.getTrackerLines().find((line): boolean => line.original === 'bbb');

    expect(survivor?.isStateOriginal()).toBe(true);
    expect(survivor?.currentPosition).toBe(2);

    // Only the inserted line is new; nothing else is added or changed.
    expect(positions(snapshot, ChangeType.added)).toEqual([0]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(removedTrackerCount(snapshot)).toBe(2);
  });

  it('keeps two mid-line splits in one transaction independent', () => {
    const doc = 'ab\ncd\nef\ngh';
    const snapshot = new FileSnapshot(doc);

    // Split "ab" after "a" and "ef" after "e" in one transaction
    // -> a, b, cd, e, f, gh. Each split is one changed + one added line.
    step(snapshot, doc, [
      { from: lineRange(doc, 1).from + 1, insert: '\n' },
      { from: lineRange(doc, 3).from + 1, insert: '\n' },
    ]);

    expect(positions(snapshot, ChangeType.changed)).toEqual([0, 3]);
    expect(positions(snapshot, ChangeType.added)).toEqual([1, 4]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    expect(snapshot.trackers.findCurrentLine(2)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(5)?.isStateOriginal()).toBe(true);
  });

  it('maps a later in-place whole-line replacement onto the right shifted tracker', () => {
    const doc = 'aaa\nbbb\nccc\nddd';
    const snapshot = new FileSnapshot(doc);

    // Insert "XXX" at the top, then replace whole line "ccc" with "CCC" in one
    // transaction -> XXX, aaa, bbb, CCC, ddd. The equal-counts in-place edit runs
    // after the insert shifted every tracker down, so it must still land on ccc.
    step(snapshot, doc, [
      { from: lineRange(doc, 1).from, insert: 'XXX\n' },
      { from: lineRange(doc, 3).from, to: lineRange(doc, 3).to, insert: 'CCC' },
    ]);

    expect(positions(snapshot, ChangeType.added)).toEqual([0]);
    expect(positions(snapshot, ChangeType.changed)).toEqual([3]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
    // The changed line at index 3 is the original "ccc" edited in place, not a
    // survivor an earlier range shifted into that slot.
    expect(snapshot.trackers.findCurrentLine(3)?.original).toBe('ccc');
    expect(snapshot.trackers.findCurrentLine(1)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(2)?.isStateOriginal()).toBe(true);
    expect(snapshot.trackers.findCurrentLine(4)?.isStateOriginal()).toBe(true);
  });
});
