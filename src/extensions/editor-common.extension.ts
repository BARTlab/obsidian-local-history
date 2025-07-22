import { ChangeType, IndicatorType } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { BaseExtension } from '@/extensions/base.extension';
import type { ChangeLine } from '@/lines/change.line';
import type { ArrayMap } from '@/maps/array.map';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { EditorExtension } from '@/types';
import { type Line, RangeSetBuilder } from '@codemirror/state';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
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

  // todo remember hash to avoid restarting re-render

  /**
   * Handles updates to the editor view.
   * Updates decorations when the document changes.
   *
   * @param {ViewUpdate} update - The view update event from CodeMirror
   * @return {void}
   */
  public update(update: ViewUpdate): void {
    if (!update.docChanged) {
      //   return;
    }

    this.updateDecorations();
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
   * Creates line decorations for each line that has changes of enabled types.
   *
   * @return {DecorationSet} The built decoration set
   */
  protected buildDecorations(): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const enable: ChangeType[] = this.getEnableTypes();
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const changes: ArrayMap<ChangeLine> = snapshot?.getChanges(enable);

    for (let i: number = 0; i <= this.view.state.doc.lines - 1; i++) {
      const line: Line = this.view.state.doc.line(i + 1);
      const change: ChangeLine = changes?.get(i) ?? null;
      const classNames: string[] = ['lct', `lct-${IndicatorType.line}`];

      if (!change) {
        continue;
      }

      change.getTypes().forEach((type: ChangeType): void => {
        classNames.push(`lct-${type}`);
      });

      const decoration: Decoration = Decoration.line({
        attributes: {
          class: classNames.join(' '),
        },
      });

      builder.add(line.from, line.from, decoration);
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
      ...this.settingsService.value('show.changed') ? [ChangeType.changed] : [],
      ...this.settingsService.value('show.restored') ? [ChangeType.restored] : [],
      ...this.settingsService.value('show.added') ? [ChangeType.added] : [],
      ...this.settingsService.value('show.removed') ? [ChangeType.removed] : [],
    ];
  }
}
