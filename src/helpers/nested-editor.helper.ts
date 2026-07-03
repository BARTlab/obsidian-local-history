import type { Editor, MarkdownFileInfo } from 'obsidian';
import { editorInfoField } from 'obsidian';
import type { StateField } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Obsidian's declaration of the field binds the StateField type from its own
 * resolution of `@codemirror/state`, which TypeScript treats as a different
 * nominal type than this project's resolution (duplicate private members).
 * Re-bind it once to the local resolution; the runtime value is identical.
 */
const infoField: StateField<MarkdownFileInfo> = editorInfoField as unknown as StateField<MarkdownFileInfo>;

/**
 * Detects a nested sub-editor: an EditorView Obsidian mounts inside another
 * editor's DOM, most notably the Live Preview table cell editors. Obsidian
 * instantiates every extension registered via `registerEditorExtension` in
 * those mini-editors too, but their document holds only the fragment being
 * edited (a single cell), so change tracking and gutter markers must ignore
 * them: cell-local line numbers do not map onto the file's lines.
 *
 * A cell editor shares its `editorInfoField` owner with the outer editor, and
 * the owner's `editor.cm` always references the outer view, so a mismatch with
 * the asking view identifies a nested editor (verified against Obsidian
 * 1.12.7: the cell editor is constructed with the outer editor's owner, while
 * standalone surfaces such as popouts, embeds and canvas cards resolve their
 * own view). When no owner editor is resolvable, the stable wrapper class of
 * the table cell widget is checked as a DOM fallback.
 *
 * @param {EditorView | null | undefined} view - The editor view to classify
 * @return {boolean} True when the view is a nested sub-editor
 */
export function isNestedEditor(view: EditorView | null | undefined): boolean {
  if (!view) {
    return false;
  }

  const info: MarkdownFileInfo | undefined = view.state.field(infoField, false);
  const outer: EditorView | undefined = (info?.editor as (Editor & { cm?: EditorView }) | undefined)?.cm;

  if (outer) {
    return outer !== view;
  }

  return view.dom.closest('.table-cell-wrapper') !== null;
}
