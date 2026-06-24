import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { EditorState } from '@codemirror/state';

// ChangeLayerExtension imports `layer` and `RectangleMarker` from
// @codemirror/view at module load time. Stub the view module so the class
// loads under the Node test environment without a DOM. ChangeDetectorExtension
// (used by applyEdit) reads Decoration.none at field-init time; include it too.
jest.mock('@codemirror/view', () => {
  const RectangleMarkerStub = class {
    public constructor(
      public readonly className: string,
      public readonly left: number,
      public readonly top: number,
      public readonly width: number | null,
      public readonly height: number,
    ) {}
  };

  return {
    layer: (): unknown => ({}),
    RectangleMarker: RectangleMarkerStub,
    Decoration: { none: {}, line: (): unknown => ({}) },
    GutterMarker: class {
      public eq(_other: unknown): boolean { return false; }
    },
  };
});

import { ChangeType, IndicatorType } from '@/consts';
import { ChangeLayerExtension } from '@/extensions/change-layer.extension';
import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { TOKENS } from '@/services/tokens';
import type { EditorView } from '@codemirror/view';

// ---------------------------------------------------------------------------
// Shared types (avoid using ChangeLayerExtension generic constructor type
// since TypeScript resolves overloaded protected method unions in odd ways)
// ---------------------------------------------------------------------------

type PluginLike = {
  get: (key: unknown) => unknown;
  isReady: () => boolean;
};

// Internal view of the extension that exposes protected methods for testing.
type ExtInternal = {
  markers: (view: EditorView) => Array<{ className: string }>;
  buildMarkers: (view: EditorView, changes: unknown) => Array<{ className: string }>;
  classNamesFor: (types: Set<ChangeType>) => string;
  rowIndexForOffset: (offset: number) => number;
  findBlockTable: (view: EditorView, block: { from: number; to: number }) => HTMLTableElement | null;
  isHidden: (view: EditorView, pos: number) => boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fake plugin whose container resolves the injected services.
 */
const makePlugin = (overrides: {
  snapshotOverride?: FileSnapshot | null;
  indicatorType?: IndicatorType;
  showChanged?: boolean;
  showRestored?: boolean;
  showAdded?: boolean;
  isReady?: boolean;
} = {}): PluginLike => {
  const {
    snapshotOverride = null,
    indicatorType = IndicatorType.line,
    showChanged = true,
    showRestored = true,
    showAdded = true,
    isReady = true,
  } = overrides;

  const settingsService = {
    value: (path: string): unknown => {
      if (path === 'type') return indicatorType;
      if (path === 'show.changed') return showChanged;
      if (path === 'show.restored') return showRestored;
      if (path === 'show.added') return showAdded;

      return undefined;
    },
  };

  const snapshotsService = {
    getOne: (): FileSnapshot | null => snapshotOverride,
    forceUpdate: jest.fn(),
  };

  const services: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.settings, settingsService],
    [TOKENS.snapshots, snapshotsService],
  ]);

  return {
    get: (key: unknown): unknown => services.get(key),
    isReady: (): boolean => isReady,
  };
};

/**
 * Applies one editor transaction to a FileSnapshot using the ChangeDetector
 * harness (real EditorState + snapshot update). Returns the new document string.
 */
const applyEdit = (snapshot: FileSnapshot, currentDoc: string, changes: unknown): string => {
  const start = EditorState.create({ doc: currentDoc });
  const tr = start.update({ changes: changes as Parameters<typeof start.update>[0]['changes'] });
  const newDoc = tr.state.doc.toString();

  type UpdateArg = Parameters<InstanceType<typeof ChangeDetectorExtension>['update']>[0];
  type DetViewArg = ConstructorParameters<typeof ChangeDetectorExtension>[0];

  const snapshotsService = { getOne: (): FileSnapshot => snapshot, forceUpdate: (): void => undefined };
  const settingsService = { value: (): unknown => false };
  const detectorPlugin = {
    get: (key: unknown): unknown => (key === TOKENS.settings ? settingsService : snapshotsService),
  };

  const ext = new ChangeDetectorExtension(
    { state: tr.state } as unknown as DetViewArg,
    detectorPlugin as unknown as ConstructorParameters<typeof ChangeDetectorExtension>[1],
  );

  ext.update({
    docChanged: true,
    changes: tr.changes,
    startState: tr.startState,
    state: tr.state,
  } as unknown as UpdateArg);

  return newDoc;
};

/**
 * Returns the byte offset of the start of 1-based line N in a doc string.
 */
const lineFrom = (doc: string, n: number): number => EditorState.create({ doc }).doc.line(n).from;

/**
 * Builds a minimal fake EditorView that simulates a document where a specific
 * position is hidden by a block widget (in the viewport but not in visibleRanges).
 *
 * @param doc - The document string to back the state
 * @param hiddenLinePos - The byte position of the line that is hidden (collapsed)
 * @param blockTop - The pixel top of the simulated block widget
 * @param blockHeight - The pixel height of the simulated block widget
 */
const makeViewWithHiddenLine = (
  doc: string,
  hiddenLinePos: number,
  blockTop: number = 10,
  blockHeight: number = 20,
): EditorView => {
  const state = EditorState.create({ doc });

  const contentRect: DOMRect = {
    left: 50, top: 0, right: 200, bottom: 100, width: 150, height: 100, x: 50, y: 0,
    toJSON: (): string => '',
  } as DOMRect;

  const scrollRect: DOMRect = {
    left: 40, top: 0, right: 210, bottom: 100, width: 170, height: 100, x: 40, y: 0,
    toJSON: (): string => '',
  } as DOMRect;

  return {
    state,
    // Viewport covers the whole document.
    viewport: { from: 0, to: doc.length },
    // visibleRanges excludes hiddenLinePos so the position is treated as hidden.
    visibleRanges: [{ from: hiddenLinePos + 1, to: doc.length }],
    lineBlockAt: (_pos: number) => ({
      from: hiddenLinePos,
      to: hiddenLinePos,
      top: blockTop,
      bottom: blockTop + blockHeight,
      height: blockHeight,
      type: 1,
    }),
    documentPadding: { top: 5, bottom: 5 },
    contentDOM: {
      getBoundingClientRect: (): DOMRect => contentRect,
      querySelectorAll: (): NodeListOf<HTMLElement> => ({
        length: 0,
        [Symbol.iterator]: function* () {},
        item: (_i: number): null => null,
        forEach: (_cb: unknown): void => undefined,
      } as unknown as NodeListOf<HTMLElement>),
    },
    scrollDOM: {
      getBoundingClientRect: (): DOMRect => scrollRect,
      scrollLeft: 0,
    },
  } as unknown as EditorView;
};

// Convenience cast: expose protected methods for testing.
const asInternal = (ext: ChangeLayerExtension): ExtInternal =>
  ext as unknown as ExtInternal;

// ---------------------------------------------------------------------------
// Tests: AC2 - no markers on early-return paths
// ---------------------------------------------------------------------------

describe('ChangeLayerExtension markers - early-return paths (no markers)', () => {
  it('returns no markers when the plugin is not ready', () => {
    const snap = new FileSnapshot('a\nb\nc');
    const doc = 'a\nb\nc';

    applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });

    const plugin = makePlugin({ snapshotOverride: snap, isReady: false });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine(doc, lineFrom(doc, 2));

    expect(asInternal(ext).markers(view)).toHaveLength(0);
  });

  it('returns no markers when the snapshot is null', () => {
    const plugin = makePlugin({ snapshotOverride: null });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine('a\nb\nc', 2);

    expect(asInternal(ext).markers(view)).toHaveLength(0);
  });

  it('returns no markers when the snapshot has no changes', () => {
    const snap = new FileSnapshot('a\nb\nc');
    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine('a\nb\nc', 2);

    expect(asInternal(ext).markers(view)).toHaveLength(0);
  });

  it('returns no markers when the indicator type is dot (not line)', () => {
    const doc = 'a\nb\nc';
    const snap = new FileSnapshot(doc);

    applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });

    const plugin = makePlugin({ snapshotOverride: snap, indicatorType: IndicatorType.dot });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine('a\nB\nc', lineFrom('a\nB\nc', 2));

    expect(asInternal(ext).markers(view)).toHaveLength(0);
  });

  it('returns no markers when the changed line is outside the viewport', () => {
    const doc = 'a\nb\nc\nd\ne';
    const snap = new FileSnapshot(doc);

    applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });

    // Viewport covers only lines 3-5 (the changed line 2 is below viewport.from).
    const newDoc = 'a\nB\nc\nd\ne';
    const state = EditorState.create({ doc: newDoc });

    const view = {
      state,
      viewport: { from: lineFrom(newDoc, 3), to: newDoc.length },
      visibleRanges: [{ from: lineFrom(newDoc, 3), to: newDoc.length }],
      lineBlockAt: jest.fn(),
      documentPadding: { top: 5, bottom: 5 },
      contentDOM: {
        getBoundingClientRect: (): DOMRect => ({ left: 50, top: 0 } as DOMRect),
        querySelectorAll: (): NodeListOf<HTMLElement> => ({ length: 0, [Symbol.iterator]: function* () {} } as unknown as NodeListOf<HTMLElement>),
      },
      scrollDOM: {
        getBoundingClientRect: (): DOMRect => ({ left: 40, top: 0 } as DOMRect),
        scrollLeft: 0,
      },
    } as unknown as EditorView;

    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);

    expect(asInternal(ext).markers(view)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: AC1 - changed lines inside a block range get the right marker class
// ---------------------------------------------------------------------------

describe('ChangeLayerExtension buildMarkers - block grouping and class names', () => {
  it('produces a marker for a changed line hidden by a collapsed block', () => {
    const doc = 'header\na\nb\nc';
    const snap = new FileSnapshot(doc);
    const newDoc = applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'A' });
    const changedLinePos = lineFrom(newDoc, 2);

    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine(newDoc, changedLinePos, 15, 24);

    expect(asInternal(ext).markers(view)).toHaveLength(1);
  });

  it('assigns the changed class name to a marker for a changed line', () => {
    const doc = 'header\na\nb\nc';
    const snap = new FileSnapshot(doc);
    const newDoc = applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'A' });
    const changedLinePos = lineFrom(newDoc, 2);

    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine(newDoc, changedLinePos, 15, 24);
    const result = asInternal(ext).markers(view);

    expect(result[0].className).toContain('lct-changed');
  });

  it('assigns the added class name for an added line hidden by a block', () => {
    const doc = 'header\na\nb';
    const snap = new FileSnapshot(doc);
    const newDoc = applyEdit(snap, doc, { from: lineFrom(doc, 2) + 1, insert: '\nX' });
    // "X" is the last line (added) in: header / a / b / X
    const addedLinePos = lineFrom(newDoc, 4);

    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine(newDoc, addedLinePos, 20, 24);
    const result = asInternal(ext).markers(view);

    expect(result).toHaveLength(1);
    expect(result[0].className).toContain('lct-added');
  });

  it('merges multiple change types from different lines of the same block', () => {
    // Changed line + added line collapse into one block -> single merged bar.
    const doc = 'header\na\nb\nc';
    const snap = new FileSnapshot(doc);

    // Edit line 2 ("a" -> "A"): changed.
    const afterEdit = applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'A' });

    // Add a new line after line 2: "A\nX".
    const newDoc = applyEdit(snap, afterEdit, { from: lineFrom(afterEdit, 2) + 1, insert: '\nX' });

    // Both changed and added lines are in the viewport but hidden by the same block.
    const changedPos = lineFrom(newDoc, 2);
    const addedPos = lineFrom(newDoc, 3);

    const state = EditorState.create({ doc: newDoc });
    const contentRect: DOMRect = { left: 50, top: 0, right: 200, bottom: 100, width: 150, height: 100, x: 50, y: 0, toJSON: (): string => '' } as DOMRect;
    const scrollRect: DOMRect = { left: 40, top: 0, right: 210, bottom: 100, width: 170, height: 100, x: 40, y: 0, toJSON: (): string => '' } as DOMRect;

    // lineBlockAt returns the same block object for both positions.
    const sharedBlock = { from: changedPos, to: addedPos, top: 10, bottom: 34, height: 24, type: 1 };

    const view = {
      state,
      viewport: { from: 0, to: newDoc.length },
      // Both changedPos and addedPos are excluded from visibleRanges -> hidden.
      visibleRanges: [{ from: addedPos + 5, to: newDoc.length }],
      lineBlockAt: (_pos: number) => sharedBlock,
      documentPadding: { top: 5, bottom: 5 },
      contentDOM: {
        getBoundingClientRect: (): DOMRect => contentRect,
        querySelectorAll: (): NodeListOf<HTMLElement> => ({
          length: 0,
          [Symbol.iterator]: function* () {},
          item: (_i: number): null => null,
          forEach: (_cb: unknown): void => undefined,
        } as unknown as NodeListOf<HTMLElement>),
      },
      scrollDOM: {
        getBoundingClientRect: (): DOMRect => scrollRect,
        scrollLeft: 0,
      },
    } as unknown as EditorView;

    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const result = asInternal(ext).markers(view);

    // One block -> one whole-block fallback bar (no table rects -> fallback path).
    expect(result.length).toBeGreaterThanOrEqual(1);

    // The merged class string must include both lct-changed and lct-added.
    const allClasses = result.map((m) => m.className).join(' ');

    expect(allClasses).toContain('lct-changed');
    expect(allClasses).toContain('lct-added');
  });

  it('produces no marker for a visible line (position inside visibleRanges)', () => {
    const doc = 'header\na\nb\nc';
    const snap = new FileSnapshot(doc);
    const newDoc = applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'A' });

    // The changed line IS in visibleRanges -> it is not hidden -> no layer marker.
    const state = EditorState.create({ doc: newDoc });
    const view = {
      state,
      viewport: { from: 0, to: newDoc.length },
      visibleRanges: [{ from: 0, to: newDoc.length }],
      lineBlockAt: jest.fn(),
      documentPadding: { top: 5, bottom: 5 },
      contentDOM: {
        getBoundingClientRect: (): DOMRect => ({ left: 50, top: 0 } as DOMRect),
        querySelectorAll: (): NodeListOf<HTMLElement> => ({ length: 0, [Symbol.iterator]: function* () {} } as unknown as NodeListOf<HTMLElement>),
      },
      scrollDOM: {
        getBoundingClientRect: (): DOMRect => ({ left: 40, top: 0 } as DOMRect),
        scrollLeft: 0,
      },
    } as unknown as EditorView;

    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);

    expect(asInternal(ext).markers(view)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: classNamesFor - pure logic, no DOM
// ---------------------------------------------------------------------------

describe('ChangeLayerExtension classNamesFor - CSS class building', () => {
  const ext = (): ChangeLayerExtension =>
    new ChangeLayerExtension(makePlugin() as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);

  it('includes lct, lct-line, and lct-change-bar in every marker class string', () => {
    const result = asInternal(ext()).classNamesFor(new Set([ChangeType.changed]));

    expect(result).toContain('lct');
    expect(result).toContain('lct-line');
    expect(result).toContain('lct-change-bar');
  });

  it('includes lct-changed for a changed type', () => {
    expect(asInternal(ext()).classNamesFor(new Set([ChangeType.changed]))).toContain('lct-changed');
  });

  it('includes lct-added for an added type', () => {
    expect(asInternal(ext()).classNamesFor(new Set([ChangeType.added]))).toContain('lct-added');
  });

  it('omits lct-removed for a removed-only type (removed has no bar in this layer)', () => {
    expect(asInternal(ext()).classNamesFor(new Set([ChangeType.removed]))).not.toContain('lct-removed');
  });

  it('includes lct-restored for a restored type', () => {
    expect(asInternal(ext()).classNamesFor(new Set([ChangeType.restored]))).toContain('lct-restored');
  });

  it('includes both lct-changed and lct-added when both types are present', () => {
    const result = asInternal(ext()).classNamesFor(new Set([ChangeType.changed, ChangeType.added]));

    expect(result).toContain('lct-changed');
    expect(result).toContain('lct-added');
  });
});

// ---------------------------------------------------------------------------
// Tests: rowIndexForOffset - pure logic, no DOM
// ---------------------------------------------------------------------------

describe('ChangeLayerExtension rowIndexForOffset - table row mapping', () => {
  const ext = (): ChangeLayerExtension =>
    new ChangeLayerExtension(makePlugin() as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);

  it('maps offset 0 (header row) to row index 0', () => {
    expect(asInternal(ext()).rowIndexForOffset(0)).toBe(0);
  });

  it('maps offset 1 (delimiter row) to -1 (no rendered row)', () => {
    expect(asInternal(ext()).rowIndexForOffset(1)).toBe(-1);
  });

  it('maps offset 2 (first data row) to row index 1', () => {
    expect(asInternal(ext()).rowIndexForOffset(2)).toBe(1);
  });

  it('maps offset 3 (second data row) to row index 2', () => {
    expect(asInternal(ext()).rowIndexForOffset(3)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: AC3 - findBlockTable degrades gracefully when posAtDOM throws
// ---------------------------------------------------------------------------

describe('ChangeLayerExtension findBlockTable - posAtDOM error handling', () => {
  it('returns null and does not throw when posAtDOM throws for every widget', () => {
    const plugin = makePlugin();
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);

    // Use a plain object stub - no real DOM needed to test the try/catch path.
    const fakeWidget = {} as HTMLElement;

    const view = {
      posAtDOM: (_el: unknown): number => {
        throw new Error('posAtDOM failed: orphaned widget');
      },
      contentDOM: {
        querySelectorAll: (): NodeListOf<HTMLElement> => {
          const list = [fakeWidget];

          return {
            length: list.length,
            item: (i: number): HTMLElement => list[i],
            [Symbol.iterator]: function* (): Generator<HTMLElement> { yield* list; },
            forEach: (cb: (el: HTMLElement) => void): void => list.forEach(cb),
          } as unknown as NodeListOf<HTMLElement>;
        },
      },
    } as unknown as EditorView;

    const block = { from: 0, to: 100 };

    expect(() => asInternal(ext).findBlockTable(view, block)).not.toThrow();
    expect(asInternal(ext).findBlockTable(view, block)).toBeNull();
  });

  it('returns null when there are no table widgets in the view', () => {
    const plugin = makePlugin();
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);

    const view = {
      posAtDOM: (): number => 0,
      contentDOM: {
        querySelectorAll: (): NodeListOf<HTMLElement> => ({
          length: 0,
          item: (_i: number): null => null,
          [Symbol.iterator]: function* () {},
          forEach: (_cb: unknown): void => undefined,
        } as unknown as NodeListOf<HTMLElement>),
      },
    } as unknown as EditorView;

    expect(asInternal(ext).findBlockTable(view, { from: 0, to: 100 })).toBeNull();
  });

  it('returns null when the widget position is outside the block range', () => {
    const plugin = makePlugin();
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);

    // Use a plain object stub - no real DOM needed to test range-check logic.
    const fakeWidget = {} as HTMLElement;

    const view = {
      // posAtDOM returns a position outside the block range [10, 50].
      posAtDOM: (_el: unknown): number => 200,
      contentDOM: {
        querySelectorAll: (): NodeListOf<HTMLElement> => {
          const list = [fakeWidget];

          return {
            length: list.length,
            item: (i: number): HTMLElement => list[i],
            [Symbol.iterator]: function* (): Generator<HTMLElement> { yield* list; },
            forEach: (cb: (el: HTMLElement) => void): void => list.forEach(cb),
          } as unknown as NodeListOf<HTMLElement>;
        },
      },
    } as unknown as EditorView;

    expect(asInternal(ext).findBlockTable(view, { from: 10, to: 50 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: buildMarkers with restored changes
// ---------------------------------------------------------------------------

describe('ChangeLayerExtension buildMarkers - restored change type', () => {
  it('marks a block with restored class when a restored line is inside it', () => {
    const doc = 'header\na\nb\nc';
    const snap = new FileSnapshot(doc);

    // Edit line 2 then restore it.
    const afterEdit = applyEdit(snap, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'A' });
    const newDoc = applyEdit(snap, afterEdit, { from: lineFrom(afterEdit, 2), to: lineFrom(afterEdit, 2) + 1, insert: 'a' });

    const restoredPos = lineFrom(newDoc, 2);

    const plugin = makePlugin({ snapshotOverride: snap });
    const ext = new ChangeLayerExtension(plugin as unknown as ConstructorParameters<typeof ChangeLayerExtension>[0]);
    const view = makeViewWithHiddenLine(newDoc, restoredPos, 15, 24);
    const result = asInternal(ext).markers(view);

    expect(result).toHaveLength(1);
    expect(result[0].className).toContain('lct-restored');
  });
});
