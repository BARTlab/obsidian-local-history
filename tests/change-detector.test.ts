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

import { ChangeType } from '@/consts';
import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';
import { FileSnapshot } from '@/snapshots/file.snapshot';

type ViewArg = ConstructorParameters<typeof ChangeDetectorExtension>[0];
type PluginArg = ConstructorParameters<typeof ChangeDetectorExtension>[1];
type UpdateArg = Parameters<ChangeDetectorExtension['update']>[0];

const positions = (snapshot: FileSnapshot, type: ChangeType): number[] =>
  snapshot
    .getChanges(type)
    .simplify()
    .map((change): number => change.getLine())
    .sort((a: number, b: number): number => a - b);

const removedTrackerCount = (snapshot: FileSnapshot): number =>
  snapshot.tracker.filter((line): boolean => line.isStateRemoved()).length;

/**
 * Applies one editor transaction to `currentDoc` and feeds the resulting
 * ChangeSet through the detector's public update() path (so the hash-skip guard
 * is exercised too). Returns the new document string for threading subsequent
 * steps. The snapshot's last state must already equal `currentDoc`.
 */
const step = (snapshot: FileSnapshot, currentDoc: string, changes: ChangeSpec): string => {
  const start: EditorState = EditorState.create({ doc: currentDoc });
  const tr = start.update({ changes });
  const plugin = { get: (): unknown => ({ getOne: (): FileSnapshot => snapshot, forceUpdate: (): void => undefined }) };
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

    expect(snapshot.getChangesLinesCount()).toBe(0);
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
    expect(snapshot.findCurrentLine(1)?.isStateOriginal()).toBe(true);
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
    expect(snapshot.findCurrentLine(1)?.isStateOriginal()).toBe(true);
    expect(snapshot.findCurrentLine(2)?.isStateOriginal()).toBe(true);
  });
});

describe('ChangeDetectorExtension line replacement (T2.2 off-by-one)', () => {
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
    expect(snapshot.findCurrentLine(0)?.isStateOriginal()).toBe(true);
    expect(snapshot.findCurrentLine(4)?.isStateOriginal()).toBe(true);
    expect(positions(snapshot, ChangeType.added)).toEqual([1, 2, 3]);
    expect(removedTrackerCount(snapshot)).toBe(2);
    expect(positions(snapshot, ChangeType.changed)).toEqual([]);
    expect(positions(snapshot, ChangeType.restored)).toEqual([]);
  });
});

describe('ChangeDetectorExtension prev-state desync (T2.3)', () => {
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
    snapshot.updateState(['aaaaaa', 'x']);

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
    expect(snapshot.findCurrentLine(1)?.isStateOriginal()).toBe(true);
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
