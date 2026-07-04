import { GutterHoverPanel } from '@/components/gutter-hover-panel';
import { resolveHoverPanelContent } from '@/components/gutter-hover-panel-content';
import type {
  GutterHoverPanelActionLabels,
  GutterHoverPanelContent,
  GutterHoverPanelHost,
  GutterHoverPanelResolution,
} from '@/components/gutter-hover-panel.types';
import { ChangeType, IndicatorType, PluginEvent } from '@/consts';
import { Inject } from '@/decorators/inject.decorator';
import { confirmAndRevertHunk } from '@/helpers/hunk-revert.helper';
import { isNestedEditor } from '@/helpers/nested-editor.helper';
import type { ChangeLine } from '@/lines/change.line';
import type LineChangeTrackerPlugin from '@/main';
import type { ArrayMap } from '@/maps/array.map';
import { BarMarker } from '@/markers/bar.marker';
import type { I18nService } from '@/services/i18n.service';
import type { ModalsService } from '@/services/modals.service';
import type { SettingsService } from '@/services/settings.service';
import type { SnapshotsService } from '@/services/snapshots.service';
import { TOKENS } from '@/services/tokens';
import type { FileSnapshot } from '@/snapshots/file.snapshot';
import type { GutterConfig, Handlers } from '@/types';
import { Notice, setIcon } from 'obsidian';
import { type Line, type RangeSet, RangeSetBuilder } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Draws the `line` change bar inside its own gutter column, placed before the
 * line-number gutter. Replaces the former `.cm-line` margin bar: a real gutter
 * marker never shares pseudo-elements with the theme's blockquote marker, so the
 * quote-line special-casing the margin bar needed disappears, and a gutter
 * element naturally covers Live Preview block widgets (tables, callouts, embeds)
 * that the per-line decoration could not reach.
 *
 * One marker per changed line. A line carrying a positive change renders a bar
 * of that kind; a pure removed-anchor renders a removed dash. Mirrors
 * {@link ChangeLine#getModify}: removed is dropped when a positive kind is
 * present so a single line never stacks two markers.
 *
 * @implements {GutterConfig}
 */
export class GutterBarExtension implements GutterConfig {
  /** CSS class for the gutter wrapper element. */
  public class: string = `lct lct-gutter-bar-col lct-${IndicatorType.line}`;

  /**
   * Only render elements for changed lines, so unchanged lines leave no filler
   * and the column reads as discrete strokes per change run.
   */
  public renderEmptyElements: boolean = false;

  /**
   * Opens the hover panel from a bar marker on pointer dwell and closes it when
   * the pointer leaves. Wired on the gutter (not the marker) so the marker stays
   * about change semantics; a hover resolves the gutter element under the pointer
   * and its 0-based line, and only a real marker cell (never the empty column,
   * which has no element) opens a panel.
   */
  public domEventHandlers: Handlers = {
    mouseover: (view, line, event): boolean => {
      const anchor = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cm-gutterElement');

      if (anchor) {
        this.hoverPanel().enter(view.state.doc.lineAt(line.from).number - 1, anchor);
      }

      return false;
    },
    mouseout: (): boolean => {
      this.panel?.leave();

      return false;
    },
  };

  /** Service for accessing plugin settings. */
  @Inject(TOKENS.settings)
  protected settingsService!: SettingsService;

  /** Service for managing file snapshots. */
  @Inject(TOKENS.snapshots)
  protected snapshotsService!: SnapshotsService;

  /** Service for translations, used for the hover panel's labels. */
  @Inject(TOKENS.i18n)
  protected i18nService!: I18nService;

  /** Service for opening the history modal from the hover panel. */
  @Inject(TOKENS.modals)
  protected modalsService!: ModalsService;

  /**
   * Hover panel controller, created on first hover (one panel opens at a time
   * across views). Lazy so constructing the extension stays side-effect free;
   * {@link hoverPanel} wires its dismissal and teardown on creation. Null until
   * the first hover.
   */
  protected panel: GutterHoverPanel | null = null;

  public constructor(
    protected view: EditorView | null,
    public plugin: LineChangeTrackerPlugin,
  ) {
  }

  /**
   * Builds one bar marker for every changed line in the current snapshot.
   *
   * @param {EditorView} view - The editor view
   * @return {RangeSet<BarMarker>} The bar markers
   */
  public markers = (view: EditorView): RangeSet<BarMarker> => {
    const enable: ChangeType[] = this.settingsService.getEnabledTypes();
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();
    const changes: ArrayMap<ChangeLine> | null = snapshot?.content.getChanges(enable) ?? null;
    const builder = new RangeSetBuilder<BarMarker>();

    // Snapshot positions are file lines; a nested cell editor's doc is only
    // the cell text, so any marker rendered there would be misplaced.
    if (isNestedEditor(view) || !this.isTypeLine() || !snapshot || !changes?.size) {
      return builder.finish();
    }

    const kinds = new Map<number, ChangeType>();

    for (const pos of snapshot.content.getChangedPositions(enable)) {
      if (pos >= view.state.doc.lines) {
        continue;
      }

      const change: ChangeLine | undefined = changes.get(pos);

      if (!change) {
        continue;
      }

      /**
       * A removed anchor can collapse onto a real current line that already
       * carries a positive change. A single bar cannot represent both, so the
       * positive kind wins and removed is dropped (the dot gutter handles
       * removed in its own column). Pure removed anchors fall back to the
       * removed dash.
       */
      const modify: ChangeType | null = change.getModify();
      const kind: ChangeType | null = modify ?? (change.has(ChangeType.removed) ? ChangeType.removed : null);

      if (kind === null) {
        continue;
      }

      kinds.set(pos, kind);
    }

    /**
     * A bar joins its neighbour when both lines carry a full bar, so CSS can
     * bridge the sub-pixel seam between the gutter elements and flatten the
     * shared edge. The removed dash is not a bar: it neither joins nor lets
     * the bars around it join across the anchor.
     */
    const isBar = (pos: number): boolean => {
      const kind: ChangeType | undefined = kinds.get(pos);

      return kind !== undefined && kind !== ChangeType.removed;
    };

    const positions: number[] = [...kinds.keys()].sort((a: number, b: number): number => a - b);

    for (const pos of positions) {
      const kind: ChangeType = kinds.get(pos) as ChangeType;
      const joins: boolean = kind !== ChangeType.removed;
      const line: Line = view.state.doc.line(pos + 1);

      builder.add(line.from, line.from, new BarMarker(kind, joins && isBar(pos - 1), joins && isBar(pos + 1)));
    }

    return builder.finish();
  };

  /**
   * Lazily builds the hover panel controller and wires its lifecycle to the
   * plugin: a snapshot refresh (which rebuilds the gutter and dislodges the
   * anchor) or a settings change dismisses it, and plugin unload detaches those
   * listeners and disposes it. Created on first hover so constructing the
   * extension stays side-effect free.
   *
   * @return {GutterHoverPanel} The shared hover panel controller
   */
  protected hoverPanel(): GutterHoverPanel {
    if (this.panel) {
      return this.panel;
    }

    const host: GutterHoverPanelHost = {
      isEnabled: (): boolean => this.settingsService.value('gutterHoverPanel'),
      getContainer: (): HTMLElement => document.body,
      ariaLabel: (): string => this.i18nService.t('menu.local-history'),
      resolveContent: (line: number): GutterHoverPanelContent | null => this.resolveHover(line)?.content ?? null,
      actionLabels: (): GutterHoverPanelActionLabels => ({
        revert: this.i18nService.t('modal.revert-hunk'),
        copy: this.i18nService.t('modal.copy'),
        history: this.i18nService.t('menu.local-history.show-history'),
      }),
      applyIcon: (element: HTMLElement, icon: string): void => setIcon(element, icon),
      revert: (line: number): Promise<void> => this.revertHover(line),
      copyOldText: (line: number): void => this.copyHover(line),
      openHistory: (): void => {
        this.modalsService.diff();
      },
    };

    const panel: GutterHoverPanel = new GutterHoverPanel(host);
    const dismiss = (): void => panel.dismiss();

    this.plugin.on(PluginEvent.snapshotsUpdate, dismiss);
    this.plugin.on(PluginEvent.settingsUpdate, dismiss);
    this.plugin.register((): void => {
      this.plugin.off(PluginEvent.snapshotsUpdate, dismiss);
      this.plugin.off(PluginEvent.settingsUpdate, dismiss);
      panel.destroy();
    });

    this.panel = panel;

    return panel;
  }

  /**
   * Resolves the hovered line against the current snapshot into the panel's
   * display model plus the block its actions operate on, or null when no
   * snapshot or no change block covers the line. The diff is computed against the
   * live snapshot content, the same inputs the gutter reverts diff against.
   *
   * @param {number} line - The 0-based hovered line
   * @return {GutterHoverPanelResolution | null} The resolution, or null
   */
  protected resolveHover(line: number): GutterHoverPanelResolution | null {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();

    if (!snapshot?.file) {
      return null;
    }

    return resolveHoverPanelContent(
      snapshot.content.getOriginalStateLines(),
      snapshot.content.getLastStateLines(),
      snapshot.content.lineBreak,
      line,
    );
  }

  /**
   * Reverts the hovered change block back to the base through the shared
   * confirm-and-revert helper the dot and removed gutters also use, resolving the
   * hunk fresh against the live content so it is never stale. A missing snapshot
   * or unresolved block is a safe no-op.
   *
   * @param {number} line - The 0-based hovered line
   * @return {Promise<void>}
   */
  protected async revertHover(line: number): Promise<void> {
    const snapshot: FileSnapshot | null = this.snapshotsService.getOne();

    if (!snapshot?.file) {
      return;
    }

    const currentLines: string[] = snapshot.content.getLastStateLines();
    const resolution: GutterHoverPanelResolution | null = resolveHoverPanelContent(
      snapshot.content.getOriginalStateLines(),
      currentLines,
      snapshot.content.lineBreak,
      line,
    );

    if (!resolution) {
      return;
    }

    await confirmAndRevertHunk({
      modalsService: this.modalsService,
      snapshotsService: this.snapshotsService,
      plugin: this.plugin,
      file: snapshot.file,
      currentLines,
      hunk: resolution.hunk,
      cancelText: this.plugin.t('modal.confirm.cancel'),
    });
  }

  /**
   * Copies the hovered block's base-side text to the clipboard and confirms with
   * a notice, mirroring the diff modal's copy affordance. A missing snapshot or
   * unresolved block is a safe no-op.
   *
   * @param {number} line - The 0-based hovered line
   * @return {void}
   */
  protected copyHover(line: number): void {
    const resolution: GutterHoverPanelResolution | null = this.resolveHover(line);

    if (!resolution) {
      return;
    }

    void navigator.clipboard.writeText(resolution.baseText).then((): void => {
      new Notice(this.plugin.t('notice.copied'));
    });
  }

  /**
   * Whether the indicator type is `line`.
   *
   * @return {boolean} True in line mode
   */
  protected isTypeLine(): boolean {
    return this.settingsService.value('type') === IndicatorType.line;
  }
}
