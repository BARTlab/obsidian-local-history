import { DiffOutputFormatType, DiffViewMode, WordDiffLineType } from '@/consts';
import { DomHelper } from '@/helpers/dom.helper';
import { HunkHelper } from '@/helpers/hunk.helper';
import { WordDiffHelper } from '@/helpers/word-diff.helper';
import type {
  DiffRenderParams,
  DomElementConfig,
  FunctionVoid,
  InlineDiffLine
} from '@/types';
import * as Diff from 'diff';
import * as Diff2Html from 'diff2html';
import { Notice, setIcon } from 'obsidian';

/**
 * Stateless DOM renderer for the four diff modes used by the history modals.
 *
 * Extracted from {@link HistoryModal} so {@link FolderHistoryModal} can render
 * the same diff verbatim without inheriting modal state or duplicating ~400
 * lines of mode plumbing (D6). The renderer:
 * - computes the line-level hunks once and reuses them for the unified patch,
 *   the inline view and the diff2html call (so callers do not recompute them),
 * - writes the resulting DOM into the provided container, and
 * - returns the hunk list so the caller can attach per-hunk revert affordances
 *   and drive next/previous navigation against the same indices the renderer
 *   used internally.
 *
 * The helper holds no modal-specific concerns. The copy-to-clipboard handler
 * inside the patch mode uses Obsidian's `Notice` directly because it is the
 * only side effect the patch button needs; everything else (notices, columns
 * header, scroll sync, per-hunk revert) is the caller's responsibility.
 */
export class DiffRenderHelper {
  /**
   * Renders the diff in the requested mode into the supplied container. The
   * container is fully replaced on every call (no incremental update), so the
   * caller can re-render on a mode toggle or a content change without having
   * to clear it first.
   *
   * @param {DiffRenderParams} params - The render parameters
   * @return {{ hunks: Diff.StructuredPatchHunk[] }} The line-level hunks the
   *   renderer used, in top-to-bottom order, so the caller can attach per-hunk
   *   navigation and revert affordances against the same indices.
   */
  public static render(params: DiffRenderParams): { hunks: Diff.StructuredPatchHunk[] } {
    const hunks: Diff.StructuredPatchHunk[] = HunkHelper.diff(
      params.baseLines,
      params.currentLines,
      params.lineBreak,
    );

    switch (params.mode) {
      case DiffViewMode.patch:
        DiffRenderHelper.renderPatch(params);

        break;
      case DiffViewMode.inline:
        DiffRenderHelper.renderInline(params);

        break;
      case DiffOutputFormatType.line:
      case DiffOutputFormatType.side:
        DiffRenderHelper.renderDiff2Html(params, params.mode);

        break;
    }

    return { hunks };
  }

  /**
   * Builds the unified clean patch text (context size 0). When the base equals
   * the current state the helper returns the minimal empty-patch shape the
   * modal used to produce inline, so a no-change selection still renders a
   * sensible header instead of an empty pane.
   *
   * @param {DiffRenderParams} params - The render parameters
   * @return {string} The unified patch text
   */
  protected static buildCleanPatch(params: DiffRenderParams): string {
    const base: string = params.baseLines.join(params.lineBreak);
    const current: string = params.currentLines.join(params.lineBreak);

    if (base !== current) {
      return Diff.createTwoFilesPatch(
        params.filePath,
        params.filePath,
        base ?? '',
        current ?? '',
        '',
        '',
        {
          context: 0,
        }
      );
    }

    return `--- ${params.filePath}\t\n+++ ${params.filePath}\t\n`;
  }

  /**
   * Builds the unified diff text with maximum context, which is what diff2html
   * consumes. When the base equals the current state the helper returns a
   * synthetic full-content header so diff2html still renders the file as
   * unchanged context instead of producing nothing.
   *
   * @param {DiffRenderParams} params - The render parameters
   * @return {string} The unified diff text consumed by diff2html
   */
  protected static buildDiff2HtmlInput(params: DiffRenderParams): string {
    const base: string = params.baseLines.join(params.lineBreak);
    const current: string = params.currentLines.join(params.lineBreak);

    if (base !== current) {
      return Diff.createTwoFilesPatch(
        params.filePath,
        params.filePath,
        base ?? '',
        current ?? '',
        '',
        '',
        {
          context: Number.MAX_SAFE_INTEGER,
        }
      );
    }

    return [
      '===================================================================',
      `--- ${params.filePath}\t`,
      `+++ ${params.filePath}\t`,
      `@@ -1,${base.length} +1,${current.length} @@`,
      params.currentLines.map((content: string): string => ` ${content}`).join('\n'),
      '\\ No newline at end of file'
    ].join('\n');
  }

  /**
   * Renders the patch mode into the container: a `<pre>` with the unified clean
   * patch plus a copy-to-clipboard button.
   *
   * @param {DiffRenderParams} params - The render parameters
   */
  protected static renderPatch(params: DiffRenderParams): void {
    const patch: string = DiffRenderHelper.buildCleanPatch(params);

    const handlerClick: FunctionVoid = (): void => {
      navigator.clipboard.writeText(patch).then((): void => {
        new Notice(params.plugin.t('notice.copied'));
      });
    };

    DomHelper.update(
      params.container,
      {
        text: null,
        children: [
          {
            tag: 'div',
            classes: 'lct-patch-container',
            children: [
              {
                tag: 'pre',
                classes: 'lct-patch-text',
                text: patch
              },
              {
                tag: 'button',
                classes: ['lct-patch-copy-button', 'mod-outline'],
                events: {
                  click: handlerClick
                }
              }
            ]
          }
        ]
      }
    );

    /**
     * Icon-only copy button: the label lives in the tooltip and aria-label so it
     * stays usable by keyboard and screen readers, matching the toolbar buttons.
     */
    const copyButton: HTMLButtonElement | null =
      params.container.querySelector<HTMLButtonElement>('.lct-patch-copy-button');

    if (copyButton) {
      setIcon(copyButton, 'copy');
      copyButton.setAttribute('aria-label', params.plugin.t('modal.copy'));
      copyButton.setAttribute('title', params.plugin.t('modal.copy'));
    }
  }

  /**
   * Renders the inline mode into the container: one row per line, with
   * word-level spans inside modified lines, plain text inside pure additions
   * and removals, and a leading sign gutter to keep the row kind readable when
   * the colours are not enough on their own.
   *
   * @param {DiffRenderParams} params - The render parameters
   */
  protected static renderInline(params: DiffRenderParams): void {
    const base: string = params.baseLines.join(params.lineBreak);
    const current: string = params.currentLines.join(params.lineBreak);

    const diffLines: InlineDiffLine[] = WordDiffHelper.lines(base, current);
    const rows: DomElementConfig[] = [];

    diffLines.forEach((line: InlineDiffLine): void => {
      if (line.type === WordDiffLineType.context) {
        rows.push(DiffRenderHelper.makeInlineRow('context', ' ', [{ tag: 'span', text: line.oldText ?? '' }]));

        return;
      }

      /**
       * Whole added/removed lines rely on the row tint, so the text is plain.
       */
      if (line.type === WordDiffLineType.added) {
        rows.push(DiffRenderHelper.makeInlineRow('added', '+', [{ tag: 'span', text: line.newText ?? '' }]));

        return;
      }

      if (line.type === WordDiffLineType.removed) {
        rows.push(DiffRenderHelper.makeInlineRow('removed', '-', [{ tag: 'span', text: line.oldText ?? '' }]));

        return;
      }

      /**
       * Modified: a single flowing line with the word-level changes shown in
       * place - unchanged words plain, removed words struck through, added words
       * highlighted - so a wording edit reads as one line, not a before/after
       * pair. This is what makes the inline mode distinct from line-by-line.
       */
      rows.push(DiffRenderHelper.makeInlineRow(
        'modified',
        '~',
        DiffRenderHelper.makeInlineWordSpans(line.oldText ?? '', line.newText ?? ''),
      ));
    });

    DomHelper.update(params.container, {
      text: null,
      children: [{ tag: 'div', classes: 'lct-inline-container', children: rows }],
    });
  }

  /**
   * Renders one of the two diff2html modes (line-by-line or side-by-side) into
   * the container using the same custom templates the modal used before the
   * extraction, so the resulting DOM is byte-for-byte identical.
   *
   * @param {DiffRenderParams} params - The render parameters
   * @param {DiffOutputFormatType} format - The diff2html output format
   */
  protected static renderDiff2Html(params: DiffRenderParams, format: DiffOutputFormatType): void {
    const diffHtml: string = Diff2Html.html(DiffRenderHelper.buildDiff2HtmlInput(params), {
      drawFileList: false,
      matching: 'lines',
      outputFormat: format,
      renderNothingWhenEmpty: true,
      rawTemplates: {
        'line-by-line-file-diff': `
           {{{diffs}}}
        `,
        'side-by-side-file-diff': `
          <div class="d2h-side-column">
            <div class="d2h-side-column-wrapper">
                <div class="d2h-side-column-container">
                  {{{diffs.left}}}
              </div>
            </div>
          </div>
          <div class="d2h-side-column">
            <div class="d2h-side-column-wrapper">
                <div class="d2h-side-column-container">
                  {{{diffs.right}}}
              </div>
            </div>
          </div>
        `,
        'generic-wrapper': `
          <div class="d2h-wrapper d2h-${format === DiffOutputFormatType.line ? 'line' : 'side'}">
            <div class="d2h-container">
                {{{content}}}
            </div>
          </div>
        `,
        'generic-block-header': `
          <div class="d2h-code-row-wrapper d2h-code-header-wrapper {{CSSLineClass.INFO}}">
              <div class="d2h-code-linenumber {{CSSLineClass.INFO}}"></div>
              <div class="d2h-code-linecontent {{CSSLineClass.INFO}}">
                  <div class="d2h-code-line d2h-code-row">
                    <span class="d2h-code-line-prefix">&nbsp;</span>
                    <span class="d2h-code-line-ctn">
                      {{#blockHeader}}{{{blockHeader}}}{{/blockHeader}}{{^blockHeader}}&nbsp;{{/blockHeader}}
                    </span>
                  </div>
              </div>
          </div>
        `,
        'generic-line': `
          <div class="d2h-code-row-wrapper {{type}}">
            <div class="d2h-code-linenumber {{type}}">
              {{{lineNumber}}}
            </div>
            <div class="d2h-code-linecontent {{type}}">
                <div class="d2h-code-line d2h-code-row">
                  {{#prefix}}
                      <span class="d2h-code-line-prefix">{{{prefix}}}</span>
                  {{/prefix}}
                  {{^prefix}}
                      <span class="d2h-code-line-prefix">&nbsp;</span>
                  {{/prefix}}
                  {{#content}}
                      <span class="d2h-code-line-ctn">{{{content}}}</span>
                  {{/content}}
                  {{^content}}
                      <span class="d2h-code-line-ctn"><br></span>
                  {{/content}}
                </div>
            </div>
        </div>
        `,
      },
    });

    DomHelper.update(
      params.container,
      { html: diffHtml }
    );
  }

  /**
   * Builds one inline diff row: a sign gutter (a space, plus, minus, or tilde)
   * and the line content made of the provided spans.
   *
   * @param {string} kind - The row kind, used as a modifier class
   * @param {string} sign - The leading sign character for the row
   * @param {DomElementConfig[]} content - The content spans for the line
   * @return {DomElementConfig} The row element config
   */
  protected static makeInlineRow(kind: string, sign: string, content: DomElementConfig[]): DomElementConfig {
    return {
      tag: 'div',
      classes: ['lct-inline-row', `lct-inline-${kind}`],
      children: [
        { tag: 'span', classes: 'lct-inline-sign', text: sign },
        { tag: 'span', classes: 'lct-inline-content', children: content },
      ],
    };
  }

  /**
   * Computes the word-level spans for a modified line as one flowing sequence:
   * unchanged words plain, removed words marked for deletion, added words
   * marked for insertion, all kept in their original order. This is what lets
   * the inline mode show a wording change as a single line instead of a
   * before/after pair.
   *
   * @param {string} oldText - The old (base) line text
   * @param {string} newText - The new (current) line text
   * @return {DomElementConfig[]} The ordered span configs for the merged line
   */
  protected static makeInlineWordSpans(oldText: string, newText: string): DomElementConfig[] {
    return WordDiffHelper.segments(oldText, newText).map((segment: Diff.Change): DomElementConfig => {
      const classes: string | undefined = segment.added
        ? 'lct-word-added'
        : segment.removed
          ? 'lct-word-removed'
          : undefined;

      return classes ? { tag: 'span', classes, text: segment.value } : { tag: 'span', text: segment.value };
    });
  }
}
