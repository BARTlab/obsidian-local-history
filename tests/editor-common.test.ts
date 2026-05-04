import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { EditorState } from '@codemirror/state';

// EditorCommonExtension imports Decoration from @codemirror/view at class-field
// init time. Stub the view layer so the extension loads under the node test
// environment without touching the DOM. The gating tests never build real
// decorations (the change lookup returns null), so Decoration.line is a no-op.
jest.mock('@codemirror/view', () => ({
  Decoration: { none: {}, line: (): unknown => ({}) },
}));

import { EditorCommonExtension } from '@/extensions/editor-common.extension';
import { refreshDecorationsEffect } from '@/extensions/refresh.effect';

type ViewArg = ConstructorParameters<typeof EditorCommonExtension>[0];
type PluginArg = ConstructorParameters<typeof EditorCommonExtension>[1];
type UpdateArg = Parameters<EditorCommonExtension['update']>[0];

interface Fakes {
  ext: EditorCommonExtension;
  getChange: jest.Mock;
}

/**
 * Builds an EditorCommonExtension wired to fake services and a fake view.
 * `type: 'line'` keeps decoration building enabled; the change lookup is a spy
 * that returns null by default so no real decorations are produced.
 */
const makeExt = (doc: string, visibleRanges: { from: number; to: number }[]): Fakes => {
  const getChange = jest.fn((): unknown => null);
  const settings = { value: (key: string): unknown => (key === 'type' ? 'line' : true) };
  const snapshot = { getChanges: (): unknown => ({ get: getChange }) };
  const services: Record<string, unknown> = {
    SettingsService: settings,
    SnapshotsService: { getOne: (): unknown => snapshot },
  };
  const plugin = { get: (name: string): unknown => services[name] };
  const view = { visibleRanges, state: EditorState.create({ doc }) };
  const ext = new EditorCommonExtension(view as unknown as ViewArg, plugin as unknown as PluginArg);

  return { ext, getChange };
};

const cursorOnlyUpdate = (): UpdateArg => ({
  docChanged: false,
  viewportChanged: false,
  transactions: [{ effects: [] }],
} as unknown as UpdateArg);

describe('EditorCommonExtension rebuild gating', () => {
  it('does not rebuild decorations on a cursor-only update', () => {
    const { ext } = makeExt('a\nb\nc', []);
    const spy = jest.spyOn(ext as unknown as { updateDecorations: () => void }, 'updateDecorations');

    ext.update(cursorOnlyUpdate());

    expect(spy).not.toHaveBeenCalled();
  });

  it('rebuilds when the document changed', () => {
    const { ext } = makeExt('a\nb\nc', []);
    const spy = jest.spyOn(ext as unknown as { updateDecorations: () => void }, 'updateDecorations');

    ext.update({ docChanged: true, viewportChanged: false, transactions: [] } as unknown as UpdateArg);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the viewport scrolled to new lines', () => {
    const { ext } = makeExt('a\nb\nc', []);
    const spy = jest.spyOn(ext as unknown as { updateDecorations: () => void }, 'updateDecorations');

    ext.update({ docChanged: false, viewportChanged: true, transactions: [] } as unknown as UpdateArg);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when a transaction carries the refresh effect', () => {
    const { ext } = makeExt('a\nb\nc', []);
    const spy = jest.spyOn(ext as unknown as { updateDecorations: () => void }, 'updateDecorations');

    ext.update({
      docChanged: false,
      viewportChanged: false,
      transactions: [{ effects: [refreshDecorationsEffect.of(null)] }],
    } as unknown as UpdateArg);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('EditorCommonExtension visible-range build', () => {
  it('queries only the lines inside the visible ranges', () => {
    const doc = 'l0\nl1\nl2\nl3\nl4\nl5';
    const state = EditorState.create({ doc });
    // Visible range spanning the 3rd and 4th lines (1-based 3..4).
    const from: number = state.doc.line(3).from;
    const to: number = state.doc.line(4).to;

    // Construction triggers the initial build over the visible range.
    const { getChange } = makeExt(doc, [{ from, to }]);

    // Change map is 0-based, so lines 3 and 4 map to indices 2 and 3.
    expect(getChange.mock.calls.map((call): unknown => call[0])).toEqual([2, 3]);
  });
});
