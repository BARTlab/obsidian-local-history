import type LineChangeTrackerPlugin from '@/main';
import type { EditorView } from '@codemirror/view';

/**
 * Base abstract class for all editor extensions.
 * Provides common functionality and properties for extensions.
 */
export abstract class BaseExtension {
  /**
   * Creates a new instance of BaseExtension.
   *
   * @param {EditorView | null} view - The CodeMirror editor view this extension is attached to
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance that manages this extension
   */
  public constructor(
    protected view: EditorView | null,
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }
}
