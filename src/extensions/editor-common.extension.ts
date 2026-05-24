import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import { refreshDecorationsEffect } from '@/extensions/refresh.effect';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import type LineChangeTrackerPlugin from '@/main';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { EditorExtension } from '@/types';
import { type Line, RangeSetBuilder, type Transaction } from '@codemirror/state';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import { Decoration } from '@codemirror/view';

/**
 * Extension that adds line decorations to the editor based on change status.
 * Highlights lines that have been added, modified, removed, or restored.
 *
 * @implements {EditorExtension}
 * @extends {BaseExtension}
 */
export class EditorCommonExtension extends BaseExtension implements EditorExtension {
  /**
   * Service for accessing plugin settings.
   * Injected using the @Inject decorator.
   */
  @Inject('SettingsService')
  protected settingsService: SettingsService;

  /**
   * Service for managing file snapshots.
   * Injected using the @Inject decorator.
   */
  @Inject('SnapshotsService')
  protected snapshotsService: SnapshotsService;

  /**
   * Set of decorations to be applied to the editor.
   * Initialized with an empty decoration set.
   */
  public decorations: DecorationSet = Decoration.none;

  /**
   * Creates a new instance of EditorCommonExtension.
   * Builds the initial decoration set so a freshly opened view already
   * reflects the current snapshot without waiting for the first update.
   *
   * @param {EditorView | null} view - The CodeMirror editor view
   * @param {LineChangeTrackerPlugin} plugin - The plugin instance
   */
  public constructor(view: EditorView | null, plugin: LineChangeTrackerPlugin) {
    super(view, plugin);

    this.updateDecorations();
  }

  /**
   * Handles updates to the editor view.
   * Rebuilds decorations only when the document changed, the viewport
   * scrolled to new lines, or a refresh effect signalled that the snapshot or
   * settings changed. Cursor-only and selection updates are ignored.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   * @return {void}
   */
  public update(update: ViewUpdate): void {
    if (this.needsRebuild(update)) {
      this.updateDecorations();
    }
  }

  /**
   * Decides whether the decoration set must be rebuilt for this update.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   * @return {boolean} True if decorations need to be rebuilt
   */
  protected needsRebuild(update: ViewUpdate): boolean {
    return update.docChanged
      || update.viewportChanged
      || update.transactions.some((transaction: Transaction): boolean =>
        transaction.effects.some((effect): boolean => effect.is(refreshDecorationsEffect)));
  }

  /**
   * Updates the decorations based on the current snapshot.
   * Clears decorations if the indicator type is not 'line' or if no snapshot exists.
   */
  protected updateDecorations(): void {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();

    if (!this.isTypeLine() || !snapshot) {
      this.decorations = Decoration.none;

      return;
    }

    this.buildDecorations();
  }

  /**
   * Builds the decoration set based on the changes in the snapshot.
   * Creates line decorations only for changed lines inside the currently
   * visible ranges, so the work scales with the viewport rather than the
   * whole document.
   *
   * @return {DecorationSet} The built decoration set
   */
  protected buildDecorations(): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const enable: ChangeType[] = this.getEnableTypes();
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const changes: ArrayMap<ChangeLine> = snapshot?.getChanges(enable);

    for (const { from, to } of this.view.visibleRanges) {
      let pos: number = from;

      while (pos <= to) {
        const line: Line = this.view.state.doc.lineAt(pos);
        const change: ChangeLine = changes?.get(line.number - 1) ?? null;

        if (change) {
          const classNames: string[] = ['lct', `lct-${IndicatorType.line}`];

          change.getTypes().forEach((type: ChangeType): void => {
            classNames.push(`lct-${type}`);
          });

          builder.add(line.from, line.from, Decoration.line({
            attributes: {
              class: classNames.join(' '),
            },
          }));
        }

        pos = line.to + 1;
      }
    }

    this.decorations = builder.finish();

    return this.decorations;
  }

  /**
   * Checks if the indicator type is set to 'line'.
   *
   * @return {boolean} True if the indicator type is 'line', false otherwise
   */
  protected isTypeLine(): boolean {
    return this.settingsService.value('type') === IndicatorType.line;
  }

  /**
   * Gets the enabled change types from settings.
   * Includes only the types that are enabled in the settings.
   *
   * @return {ChangeType[]} Array of enabled change types
   */
  protected getEnableTypes(): ChangeType[] {
    return [
      ...this.settingsService.value('show.changed') ? [ChangeType.changed, ChangeType.whitespace] : [],
      ...this.settingsService.value('show.restored') ? [ChangeType.restored] : [],
      ...this.settingsService.value('show.added') ? [ChangeType.added] : [],
      ...this.settingsService.value('show.removed') ? [ChangeType.removed] : [],
    ];
  }
}
