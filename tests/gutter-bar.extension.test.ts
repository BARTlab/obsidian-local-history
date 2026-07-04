import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { type ChangeSpec, EditorState } from '@codemirror/state';
import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';

// GutterBarExtension calls new BarMarker(...) during markers(). BarMarker
// extends GutterMarker from @codemirror/view; stub the view module so both
// classes load under the Node test environment without a DOM. applyEdit also
// instantiates ChangeDetectorExtension which reads Decoration.none at field-init
// time, so that must be stubbed too.
jest.mock('@codemirror/view', () => {
  // GutterMarker must inherit the real RangeValue: a bare class stub lacks
  // startSide/endSide, and RangeSet.iter() then silently skips a range
  // anchored at position 0 (a marker on the first line).
  const { RangeValue } = jest.requireActual<typeof import('@codemirror/state')>('@codemirror/state');

  return {
    GutterMarker: class extends RangeValue {
      public eq(_other: unknown): boolean { return false; }
    },
    Decoration: { none: {}, line: (): unknown => ({}) },
  };
});

import { editorInfoField } from 'obsidian';
import type { StateField } from '@codemirror/state';
import { ChangeType, IndicatorType } from '@/consts';
import { GutterBarExtension } from '@/extensions/gutter-bar.extension';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import { TOKENS } from '@/services/tokens';
import type { BarMarker } from '@/markers/bar.marker';
import type { EditorView } from '@codemirror/view';
import type { RangeSet } from '@codemirror/state';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type ExtCtor = typeof GutterBarExtension;
type ViewArg = ConstructorParameters<ExtCtor>[0];
type PluginArg = ConstructorParameters<ExtCtor>[1];

// The show.* flags the bar honours through getEnabledTypes; each maps a
// ChangeType family onto a settings toggle exactly as SettingsService does.
interface ShowFlags {
  showChanged?: boolean;
  showRestored?: boolean;
  showAdded?: boolean;
  showRemoved?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fake plugin whose container resolves the two services the bar
 * extension injects (settings, snapshots). The settings stub mirrors
 * SettingsService.getEnabledTypes so the enabled-type filter is exercised
 * through the real code path, and reports the indicator type for the line-mode
 * gate. Extra tokens (modals, i18n) are present for construction parity.
 */
const makePlugin = (overrides: ShowFlags & {
  snapshotOverride?: FileSnapshot | null;
  indicatorType?: IndicatorType;
}): { plugin: PluginArg } => {
  const {
    snapshotOverride = null,
    indicatorType = IndicatorType.line,
    showChanged = true,
    showRestored = true,
    showAdded = true,
    showRemoved = true,
  } = overrides;

  const settingsService = {
    value: (path: string): unknown => (path === 'type' ? indicatorType : undefined),
    getEnabledTypes: (): ChangeType[] => [
      ...(showChanged ? [ChangeType.changed, ChangeType.whitespace] : []),
      ...(showRestored ? [ChangeType.restored] : []),
      ...(showAdded ? [ChangeType.added] : []),
      ...(showRemoved ? [ChangeType.removed] : []),
    ],
  };

  const snapshotsService = {
    getOne: (): FileSnapshot | null => snapshotOverride,
    forceUpdate: jest.fn(),
  };

  const services: Map<unknown, unknown> = new Map<unknown, unknown>([
    [TOKENS.settings, settingsService],
    [TOKENS.snapshots, snapshotsService],
    [TOKENS.i18n, { t: (key: string): string => key }],
  ]);

  const plugin = {
    get: (key: unknown): unknown => services.get(key),
    t: (key: string): string => key,
  };

  return { plugin: plugin as unknown as PluginArg };
};

/**
 * Builds a fake EditorView backed by a real EditorState for the given document
 * string, exposing the state and doc the extension reads during markers(). The
 * inert `dom` satisfies the nested-editor guard's DOM fallback (reads as a
 * root editor); `nested: true` initializes `editorInfoField` with a foreign
 * outer view so the guard classifies the view as a table-cell sub-editor.
 */
const makeView = (doc: string, nested: boolean = false): EditorView => {
  // The runtime field is the jest stub (StateField<unknown>); retype the real
  // obsidian declaration to match so init can return a plain test double.
  const infoField = editorInfoField as unknown as StateField<unknown>;
  const view = { dom: { closest: (): Element | null => null } } as unknown as EditorView;
  const extensions = nested
    ? [infoField.init((): unknown => ({ editor: { cm: {} } }))]
    : [];

  Object.assign(view, { state: EditorState.create({ doc, extensions }) });

  return view;
};

/**
 * Collects every {from, type} pair from a RangeSet<BarMarker> into a flat array
 * ordered by position, reading the bar kind off each marker.
 */
const collectMarkers = (rs: RangeSet<BarMarker>): { from: number; type: ChangeType }[] => {
  const result: { from: number; type: ChangeType }[] = [];
  const cursor = rs.iter();

  while (cursor.value !== null) {
    result.push({ from: cursor.from, type: cursor.value.getChangeType() });
    cursor.next();
  }

  return result;
};

/**
 * Applies one editor transaction to a FileSnapshot using the ChangeDetector
 * harness pattern (real EditorState + snapshot state update). Returns the new
 * document string so subsequent steps can thread off it.
 */
const applyEdit = (snapshot: FileSnapshot, currentDoc: string, changes: ChangeSpec): string => {
  const start = EditorState.create({ doc: currentDoc });
  const tr = start.update({ changes });
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
    detectorPlugin as unknown as PluginArg,
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
 * Constructs the bar extension over a plugin resolving the given snapshot, runs
 * markers() against the given document, and returns the collected bars.
 */
const runMarkers = (
  snapshot: FileSnapshot | null,
  viewDoc: string,
  flags: ShowFlags & { indicatorType?: IndicatorType } = {},
): { from: number; type: ChangeType }[] => {
  const { plugin } = makePlugin({ snapshotOverride: snapshot, ...flags });
  const ext = new GutterBarExtension(null as unknown as ViewArg, plugin);

  return collectMarkers(ext.markers(makeView(viewDoc)));
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GutterBarExtension markers - one bar per changed line, keyed by kind', () => {
  it('draws a changed bar on the edited line', () => {
    const doc = 'a\nb\nc\nd';
    const snapshot = new FileSnapshot(doc);
    // Edit line 2 ("b" -> "B").
    applyEdit(snapshot, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });

    const viewDoc = 'a\nB\nc\nd';
    const markers = runMarkers(snapshot, viewDoc);

    expect(markers).toEqual([{ from: lineFrom(viewDoc, 2), type: ChangeType.changed }]);
  });

  it('draws an added bar on each newly inserted line', () => {
    const doc = 'a\nb';
    const snapshot = new FileSnapshot(doc);
    // Paste two lines after line 1 ("a").
    applyEdit(snapshot, doc, { from: lineFrom(doc, 1) + 1, insert: '\nX\nY' });

    const viewDoc = 'a\nX\nY\nb';
    const markers = runMarkers(snapshot, viewDoc);

    // Both pasted lines (2 and 3) carry an added bar; the untouched lines do not.
    expect(markers).toEqual([
      { from: lineFrom(viewDoc, 2), type: ChangeType.added },
      { from: lineFrom(viewDoc, 3), type: ChangeType.added },
    ]);
  });

  it('draws a restored bar when a line returns to its original content', () => {
    const doc = 'a\nb\nc';
    const snapshot = new FileSnapshot(doc);
    // Edit line 2 then restore it to the original text.
    const afterEdit = applyEdit(snapshot, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    applyEdit(snapshot, afterEdit, {
      from: lineFrom(afterEdit, 2),
      to: lineFrom(afterEdit, 2) + 1,
      insert: 'b',
    });

    const markers = runMarkers(snapshot, doc);

    expect(markers).toEqual([{ from: lineFrom(doc, 2), type: ChangeType.restored }]);
  });

  it('draws a removed bar (the dash fallback) on a pure deletion anchor', () => {
    const doc = 'a\nb\nc\nd';
    const snapshot = new FileSnapshot(doc);
    // Delete line 2 ("b"): a, c, d remain; the removed anchor sits on the first
    // surviving line after the gap. getModify() is null there, so the bar falls
    // back to the removed dash - the bar column draws removed, the dot column
    // does not.
    const newDoc = applyEdit(snapshot, doc, {
      from: lineFrom(doc, 1) + 1,
      to: lineFrom(doc, 2) + 1,
      insert: '',
    });

    const markers = runMarkers(snapshot, newDoc);

    expect(markers).toEqual([{ from: lineFrom(newDoc, 2), type: ChangeType.removed }]);
  });
});

describe('GutterBarExtension hover panel gating', () => {
  /**
   * Builds a mouseover event whose gutter element carries the given kind class,
   * mirroring what BarMarker.elementClass sets on the .cm-gutterElement. No real
   * DOM is needed: closest/classList are plain stub methods.
   */
  const mouseoverEvent = (kindClass: string): unknown => ({
    target: {
      closest: (selector: string): unknown =>
        selector === '.cm-gutterElement'
          ? { classList: { contains: (c: string): boolean => c === kindClass } }
          : null,
    },
  });

  it('opens the panel on a changed marker but never on a restored one', () => {
    const { plugin } = makePlugin({});
    const ext = new GutterBarExtension(null as unknown as ViewArg, plugin);

    // Replace the lazily-built controller with a spy so no real panel/lifecycle
    // is created; we only assert whether the handler decides to open one.
    const enterSpy = jest.fn();

    jest.spyOn(ext as unknown as { hoverPanel: () => unknown }, 'hoverPanel')
      .mockReturnValue({ enter: enterSpy });

    const view = makeView('a\nb\nc');
    const line = view.state.doc.line(2);
    type MouseHandler = (v: EditorView, l: typeof line, e: unknown) => boolean;
    const mouseover = ext.domEventHandlers.mouseover as unknown as MouseHandler;

    // A restored line is already back to its original content: no panel opens.
    mouseover(view, line, mouseoverEvent(`lct-${ChangeType.restored}`));
    expect(enterSpy).not.toHaveBeenCalled();

    // A changed marker opens the panel, anchored to the 0-based line (2 -> 1).
    mouseover(view, line, mouseoverEvent(`lct-${ChangeType.changed}`));
    expect(enterSpy).toHaveBeenCalledWith(1, expect.anything());
  });
});

describe('GutterBarExtension markers - enabled-type filtering (parametrized over settings)', () => {
  interface FilterCase {
    kind: string;
    disableFlag: keyof ShowFlags;
    type: ChangeType;
    build: () => { snapshot: FileSnapshot; viewDoc: string; anchor: number };
  }

  const cases: FilterCase[] = [
    {
      kind: 'changed',
      disableFlag: 'showChanged',
      type: ChangeType.changed,
      build: () => {
        const doc = 'a\nb\nc';
        const snapshot = new FileSnapshot(doc);
        applyEdit(snapshot, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });
        const viewDoc = 'a\nB\nc';

        return { snapshot, viewDoc, anchor: lineFrom(viewDoc, 2) };
      },
    },
    {
      kind: 'added',
      disableFlag: 'showAdded',
      type: ChangeType.added,
      build: () => {
        const doc = 'a\nb';
        const snapshot = new FileSnapshot(doc);
        applyEdit(snapshot, doc, { from: lineFrom(doc, 1) + 1, insert: '\nX' });
        const viewDoc = 'a\nX\nb';

        return { snapshot, viewDoc, anchor: lineFrom(viewDoc, 2) };
      },
    },
    {
      kind: 'restored',
      disableFlag: 'showRestored',
      type: ChangeType.restored,
      build: () => {
        const doc = 'a\nb\nc';
        const snapshot = new FileSnapshot(doc);
        const afterEdit = applyEdit(snapshot, doc, {
          from: lineFrom(doc, 2),
          to: lineFrom(doc, 2) + 1,
          insert: 'B',
        });

        applyEdit(snapshot, afterEdit, {
          from: lineFrom(afterEdit, 2),
          to: lineFrom(afterEdit, 2) + 1,
          insert: 'b',
        });

        return { snapshot, viewDoc: doc, anchor: lineFrom(doc, 2) };
      },
    },
    {
      kind: 'removed',
      disableFlag: 'showRemoved',
      type: ChangeType.removed,
      build: () => {
        const doc = 'a\nb\nc\nd';
        const snapshot = new FileSnapshot(doc);
        const newDoc = applyEdit(snapshot, doc, {
          from: lineFrom(doc, 1) + 1,
          to: lineFrom(doc, 2) + 1,
          insert: '',
        });

        return { snapshot, viewDoc: newDoc, anchor: lineFrom(newDoc, 2) };
      },
    },
  ];

  it.each(cases)('draws the $kind bar when its show flag is enabled', ({ build, type }) => {
    const { snapshot, viewDoc, anchor } = build();
    const markers = runMarkers(snapshot, viewDoc);

    expect(markers).toEqual([{ from: anchor, type }]);
  });

  it.each(cases)('suppresses the $kind bar when its show flag is disabled', ({ build, disableFlag }) => {
    const { snapshot, viewDoc } = build();
    const markers = runMarkers(snapshot, viewDoc, { [disableFlag]: false });

    expect(markers).toHaveLength(0);
  });
});

describe('GutterBarExtension markers - gating and early returns', () => {
  it('yields no bars when the snapshot is null', () => {
    expect(runMarkers(null, 'a\nb\nc')).toHaveLength(0);
  });

  it('yields no bars when the snapshot has no changes', () => {
    const snapshot = new FileSnapshot('a\nb\nc');

    expect(runMarkers(snapshot, 'a\nb\nc')).toHaveLength(0);
  });

  it('yields no bars when the indicator type is dot (not line)', () => {
    const doc = 'a\nb\nc';
    const snapshot = new FileSnapshot(doc);
    applyEdit(snapshot, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });

    // The bar column renders only in line mode; the dot columns own dot mode.
    expect(runMarkers(snapshot, 'a\nB\nc', { indicatorType: IndicatorType.dot })).toHaveLength(0);
  });
});

describe('GutterBarExtension markers - out-of-range positions (boundary)', () => {
  it('produces no bar for a stale change position beyond the current document length', () => {
    const doc = 'a\nb\nc\nd\ne';
    const snapshot = new FileSnapshot(doc);
    // Change line 5 (0-based position 4), then render against a document that
    // has shrunk to two lines: the stale position sits at pos >= doc.lines.
    applyEdit(snapshot, doc, { from: lineFrom(doc, 5), to: lineFrom(doc, 5) + 1, insert: 'E' });

    const markers = runMarkers(snapshot, 'a\nb');

    expect(markers).toHaveLength(0);
  });

  it('keeps in-range bars while dropping the stale out-of-range one', () => {
    const doc = 'a\nb\nc\nd\ne\nf';
    const snapshot = new FileSnapshot(doc);
    // Two changes: line 2 (position 1, in range for a 3-line view) and line 6
    // (position 5, out of range).
    const afterFirst = applyEdit(snapshot, doc, {
      from: lineFrom(doc, 2),
      to: lineFrom(doc, 2) + 1,
      insert: 'B',
    });

    applyEdit(snapshot, afterFirst, {
      from: lineFrom(afterFirst, 6),
      to: lineFrom(afterFirst, 6) + 1,
      insert: 'F',
    });

    const viewDoc = 'a\nB\nc';
    const markers = runMarkers(snapshot, viewDoc);

    // Only the in-range change survives; the position-5 change is skipped.
    expect(markers).toEqual([{ from: lineFrom(viewDoc, 2), type: ChangeType.changed }]);
  });
});

describe('GutterBarExtension run joins', () => {
  /**
   * Collects every {from, cls} pair from the marker set so the join classes
   * (lct-join-up / lct-join-down) set by BarMarker are observable.
   */
  const runMarkerClasses = (snapshot: FileSnapshot, viewDoc: string): { from: number; cls: string }[] => {
    const { plugin } = makePlugin({ snapshotOverride: snapshot });
    const ext = new GutterBarExtension(null as unknown as ViewArg, plugin);
    const cursor = ext.markers(makeView(viewDoc)).iter();
    const result: { from: number; cls: string }[] = [];

    while (cursor.value !== null) {
      result.push({ from: cursor.from, cls: cursor.value.elementClass });
      cursor.next();
    }

    return result;
  };

  it('joins a run of consecutive bars: down, both, up', () => {
    const doc = 'a\nb';
    const snapshot = new FileSnapshot(doc);

    applyEdit(snapshot, doc, { from: lineFrom(doc, 1) + 1, insert: '\nX\nY\nZ' });

    const viewDoc = 'a\nX\nY\nZ\nb';

    expect(runMarkerClasses(snapshot, viewDoc)).toEqual([
      { from: lineFrom(viewDoc, 2), cls: 'lct-line lct-added lct-join-down' },
      { from: lineFrom(viewDoc, 3), cls: 'lct-line lct-added lct-join-up lct-join-down' },
      { from: lineFrom(viewDoc, 4), cls: 'lct-line lct-added lct-join-up' },
    ]);
  });

  it('leaves a single bar without join classes', () => {
    const doc = 'a\nb\nc';
    const snapshot = new FileSnapshot(doc);

    applyEdit(snapshot, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });

    const viewDoc = 'a\nB\nc';

    expect(runMarkerClasses(snapshot, viewDoc)).toEqual([
      { from: lineFrom(viewDoc, 2), cls: 'lct-line lct-changed' },
    ]);
  });

  it('joins across a kind switch (changed above, added below)', () => {
    const doc = 'a\nbcd\ne';
    const snapshot = new FileSnapshot(doc);

    // Mid-line split: line 2 keeps its tracker (changed), line 3 is added.
    applyEdit(snapshot, doc, { from: lineFrom(doc, 2) + 1, insert: '\n' });

    const viewDoc = 'a\nb\ncd\ne';

    expect(runMarkerClasses(snapshot, viewDoc)).toEqual([
      { from: lineFrom(viewDoc, 2), cls: 'lct-line lct-changed lct-join-down' },
      { from: lineFrom(viewDoc, 3), cls: 'lct-line lct-added lct-join-up' },
    ]);
  });

  it('does not join across a pure removed dash', () => {
    const doc = 'a\nb\nc\nd';
    const snapshot = new FileSnapshot(doc);

    // Delete line 2, then edit the lines around the anchor's resting line.
    const afterDelete = applyEdit(snapshot, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 3), insert: '' });
    const afterFirst = applyEdit(snapshot, afterDelete, { from: 0, to: 1, insert: 'A' });

    applyEdit(snapshot, afterFirst, {
      from: lineFrom(afterFirst, 3),
      to: lineFrom(afterFirst, 3) + 1,
      insert: 'D',
    });

    const viewDoc = 'A\nc\nD';

    expect(runMarkerClasses(snapshot, viewDoc)).toEqual([
      { from: lineFrom(viewDoc, 1), cls: 'lct-line lct-changed' },
      { from: lineFrom(viewDoc, 2), cls: 'lct-line lct-removed' },
      { from: lineFrom(viewDoc, 3), cls: 'lct-line lct-changed' },
    ]);
  });
});

describe('GutterBarExtension nested cell editors', () => {
  // Obsidian instantiates the gutter inside every Live Preview table cell
  // editor; a file change whose position fits the cell's tiny doc must not
  // paint the cell, only the root editor.
  it('renders no bars inside a nested cell editor', () => {
    const doc = 'a\nb';
    const snapshot = new FileSnapshot(doc);
    // Edit line 2 ("b" -> "B"): the change sits at position 1.
    applyEdit(snapshot, doc, { from: lineFrom(doc, 2), to: lineFrom(doc, 2) + 1, insert: 'B' });

    const { plugin } = makePlugin({ snapshotOverride: snapshot });
    const ext = new GutterBarExtension(null as unknown as ViewArg, plugin);
    const cellDoc = 'x\ny';

    // The same two-line doc renders the bar in a root editor...
    expect(collectMarkers(ext.markers(makeView(cellDoc)))).toHaveLength(1);
    // ...and nothing in a nested cell sub-editor.
    expect(collectMarkers(ext.markers(makeView(cellDoc, true)))).toHaveLength(0);
  });
});
