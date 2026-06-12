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
import { TOKENS } from '@/services/tokens';
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

describe('ChangeDetectorExtension removed-anchor clamping (epic 13 regression)', () => {
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
      ...snapshot.tracker
        .filter((line): boolean => line.existedInCurrent)
        .map((line): number => line.currentPosition),
    );

    snapshot.tracker
      .filter((line): boolean => line.isStateRemoved())
      .forEach((line): void => {
        expect(line.removedAtPosition).toBeGreaterThanOrEqual(0);
        expect(line.removedAtPosition).toBeLessThanOrEqual(last);
      });

    [...snapshot.getChanges().keys()]
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
  // for not stacking a removed marker onto the added bar (see editor-common).
  // This pins the anchor collision so a model-boundary change cannot silently
  // re-orphan the removed anchor off a real line.
  it('keeps the collapsed removed anchor on index 0, not past the last real line', () => {
    const snapshot = new FileSnapshot('start');

    // Add three lines below "start": start, A, B, C.
    const afterAdd: string = step(snapshot, 'start', { from: lineRange('start', 1).to, insert: '\nA\nB\nC' });

    // Del at the top removes the original "start": A, B, C remain.
    step(snapshot, afterAdd, { from: lineRange(afterAdd, 1).from, to: lineRange(afterAdd, 2).from, insert: '' });

    const last: number = Math.max(
      ...snapshot.tracker
        .filter((line): boolean => line.existedInCurrent)
        .map((line): number => line.currentPosition),
    );

    // Every removed anchor stays on a real line (>= 0 and <= last current line).
    snapshot.tracker
      .filter((line): boolean => line.isStateRemoved())
      .forEach((line): void => {
        expect(line.removedAtPosition).toBeGreaterThanOrEqual(0);
        expect(line.removedAtPosition).toBeLessThanOrEqual(last);
      });

    // No change-map key escapes the real line range.
    [...snapshot.getChanges().keys()]
      .filter((key): key is number => typeof key === 'number')
      .forEach((key: number): void => {
        expect(key).toBeGreaterThanOrEqual(0);
        expect(key).toBeLessThanOrEqual(last);
      });

    // Index 0 carries both the added line and the collapsed removed anchor.
    const top = snapshot.getChanges().get(0);

    expect(top?.has(ChangeType.added)).toBe(true);
    expect(top?.has(ChangeType.removed)).toBe(true);
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

describe('ChangeDetectorExtension CRLF normalization (ADR-08-G)', () => {
  // The editor surface must split content on /\r?\n/ rather than the CodeMirror
  // `state.lineBreak` convention, so a CRLF document does not leak a trailing
  // `\r` into the tracker (which would corrupt change content and equality).
  it('records an edited CRLF line without a trailing carriage return', () => {
    const doc = 'a\r\nb\r\nc';
    const snapshot = new FileSnapshot(doc, '\r\n');
    const { from, to } = lineRange(doc, 2);

    step(snapshot, doc, { from, to, insert: 'B' });

    const edited = snapshot.findCurrentLine(1);

    expect(edited?.current).toBe('B');
    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
    expect(positions(snapshot, ChangeType.added)).toEqual([]);
    expect(positions(snapshot, ChangeType.removed)).toEqual([]);
  });

  it('keeps LF behaviour unchanged for a plain edit', () => {
    const snapshot = new FileSnapshot('a\nb\nc');
    const { from, to } = lineRange('a\nb\nc', 2);

    step(snapshot, 'a\nb\nc', { from, to, insert: 'B' });

    const edited = snapshot.findCurrentLine(1);

    expect(edited?.current).toBe('B');
    expect(positions(snapshot, ChangeType.changed)).toEqual([1]);
  });
});

describe('ChangeDetectorExtension scale (T3.2 hot path)', () => {
  // Pastes then deletes a large block in single transactions. The old tracker
  // hot path sorted and rebuilt an ArrayMap for every shifted line (and per
  // findCurrentLine), which is O(n^2 log n) on a block this size; the indexed
  // path is linear per line. The result must stay correct and finish well under
  // the budget below, which the pre-T3.2 code would blow past.
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
    expect(snapshot.getChangesLinesCount()).toBe(0);
    expect(snapshot.tracker.filter((line): boolean => line.existedInCurrent)).toHaveLength(2);
    expect(snapshot.findCurrentLine(0)?.isStateOriginal()).toBe(true);
    expect(snapshot.findCurrentLine(1)?.isStateOriginal()).toBe(true);

    // Generous bound to stay stable on slow CI while still catching a regression
    // to the per-line sort/copy path (which runs into tens of seconds here).
    expect(elapsed).toBeLessThan(8000);
  }, 30000);
});
