import { ChangeDetectorExtension } from '@/extensions/change-detector.extension';
import { EditorCommonExtension } from '@/extensions/editor-common.extension';
import { GutterCommonExtension } from '@/extensions/gutter-common.extension';
import { GutterRemovedExtension } from '@/extensions/gutter-removed.extension';
import type LineChangeTrackerPlugin from '@/main';
import type { ClassConstructor, EditorExtension, GutterConfig, Service } from '@/types';
import type { Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, gutter, type PluginSpec, ViewPlugin } from '@codemirror/view';

/**
 * Service responsible for registering and managing editor extensions.
 * Handles the creation and registration of different types of extensions:
 * - Editor extensions (ViewPlugin instances)
 * - Gutter extensions (gutter configurations)
 *
 * @implements {Service}
 */
export class ExtensionsService implements Service {
  /**
   * Map of extension names to their instances.
   * Used to track registered extensions and prevent duplicates.
   */
  protected instances: Map<string, Extension | ViewPlugin<unknown>> = new Map();

  /**
   * Creates a new instance of ExtensionsService.
   *
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(
    protected plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Initializes the service by registering all plugin extensions.
   * Called during plugin initialization.
   */
  public init(): void {
    this.register(ChangeDetectorExtension, 'editor');
    this.register(EditorCommonExtension, 'editor');
    this.register(GutterCommonExtension, 'gutter');
    this.register(GutterRemovedExtension, 'gutter');
  }

  /**
   * Registers an extension with Obsidian.
   * Creates an instance of the extension, adds it to the instance map,
   * and registers it with the plugin.
   * Skip registration if an extension with the same name already exists.
   *
   * @template T - The extension type, either EditorExtension or GutterConfig
   * @param {ClassConstructor<T>} clsConstructor - The extension class constructor
   * @param {string} type - The type of extension ('editor' or 'gutter')
   */
  protected register<T extends EditorExtension | GutterConfig>(
    clsConstructor: ClassConstructor<T>,
    type: 'editor' | 'gutter'
  ): void {
    // @ts-ignore
    const extension: Extension | ViewPlugin<T, unknown> = this.factory<T>(clsConstructor, type);

    if (!extension || this.instances.has(clsConstructor.name)) {
      return;
    }

    this.instances.set(clsConstructor.name, extension);
    this.plugin.registerEditorExtension(extension);
  }

  /**
   * Creates a new gutter extension.
   * Factory method overload for gutter extensions.
   *
   * @template T - The extension type, extending GutterConfig
   * @param clsConstructor - The extension class constructor
   * @param type - Must be 'gutter'
   * @returns A CodeMirror gutter extension
   */
  protected factory<T extends GutterConfig>(
    clsConstructor: ClassConstructor<T>,
    type: 'gutter',
  ): Extension;

  /**
   * Creates a new editor extension.
   * Factory method overload for editor extensions.
   *
   * @template T - The extension type, extending EditorExtension
   * @param clsConstructor - The extension class constructor
   * @param type - Must be 'editor'
   * @returns A CodeMirror ViewPlugin
   */
  protected factory<T extends EditorExtension>(
    clsConstructor: ClassConstructor<T>,
    type: 'editor',
  ): ViewPlugin<T, unknown>;

  /**
   * Creates a new extension based on the specified type.
   * Implementation of the factory method that handles both extension types.
   *
   * @template T - The extension type, either EditorExtension or GutterConfig
   * @param {ClassConstructor<T>} clsConstructor - The extension class constructor
   * @param {string} type - The type of extension ('editor' or 'gutter')
   * @return {Extension|ViewPlugin} Either a CodeMirror Extension or ViewPlugin
   * @throws Error if the extension type is unknown
   */
  protected factory<T extends EditorExtension | GutterConfig>(
    clsConstructor: ClassConstructor<T>,
    type: 'editor' | 'gutter'
  ): Extension | ViewPlugin<T, unknown> {
    const plugin: LineChangeTrackerPlugin = this.plugin;

    switch (type) {
      case 'editor':
        return ViewPlugin.define(
          // eslint-disable-next-line new-cap
          (view: EditorView, arg: unknown): T => new clsConstructor(view, plugin, arg),
          {
            decorations: (view: EditorExtension): DecorationSet => (view).decorations ?? Decoration.none
          } as PluginSpec<T>
        );

      case 'gutter':
        // eslint-disable-next-line new-cap
        return gutter(new clsConstructor(null, plugin) as GutterConfig);

      default:
        throw Error(`Unknown extension type "${type}" for "${clsConstructor?.name ?? 'unknown'}"`);
    }
  }
}
