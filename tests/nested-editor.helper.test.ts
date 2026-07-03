import { describe, expect, it } from '@jest/globals';
import { EditorState, type StateField } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import { isNestedEditor } from '@/helpers/nested-editor.helper';
import type { EditorView } from '@codemirror/view';

// The runtime field is the jest stub (StateField<unknown>); retype the real
// obsidian declaration to match so init can return plain test doubles.
const infoField = editorInfoField as unknown as StateField<unknown>;

/**
 * Builds a fake EditorView whose state optionally carries the (stubbed)
 * `editorInfoField`. The `info` factory receives the view itself so a test can
 * model the root editor (owner's `editor.cm` is the view) or a nested cell
 * editor (owner's `editor.cm` is a foreign outer view). `closest` drives the
 * DOM fallback used when no owner editor is resolvable.
 */
const makeView = (
  info?: (view: EditorView) => unknown,
  closest: Element | null = null,
): EditorView => {
  const view = { dom: { closest: (): Element | null => closest } } as unknown as EditorView;
  const extensions = info === undefined ? [] : [infoField.init((): unknown => info(view))];

  Object.assign(view, { state: EditorState.create({ doc: '', extensions }) });

  return view;
};

describe('isNestedEditor', () => {
  it('classifies the root editor as not nested (owner editor.cm is the view)', () => {
    const view = makeView((self: EditorView): unknown => ({ editor: { cm: self } }));

    expect(isNestedEditor(view)).toBe(false);
  });

  it('classifies a cell sub-editor as nested (owner editor.cm is a foreign view)', () => {
    const view = makeView((): unknown => ({ editor: { cm: {} } }));

    expect(isNestedEditor(view)).toBe(true);
  });

  it('falls back to the DOM when the field is absent: no wrapper means root', () => {
    const view = makeView();

    expect(isNestedEditor(view)).toBe(false);
  });

  it('falls back to the DOM when the field is absent: a wrapper means nested', () => {
    const view = makeView(undefined, {} as Element);

    expect(isNestedEditor(view)).toBe(true);
  });

  it('falls back to the DOM when the owner has no resolvable editor', () => {
    const bare = makeView((): unknown => ({}));
    const wrapped = makeView((): unknown => ({}), {} as Element);

    expect(isNestedEditor(bare)).toBe(false);
    expect(isNestedEditor(wrapped)).toBe(true);
  });

  it('treats a missing view as not nested', () => {
    expect(isNestedEditor(null)).toBe(false);
    expect(isNestedEditor(undefined)).toBe(false);
  });
});
