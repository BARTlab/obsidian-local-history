/**
 * Hand-written render functions for the plugin's custom diff2html templates.
 *
 * diff2html normally compiles mustache templates at runtime with hogan, whose
 * compiler assembles code via `new Function`; that compiler is excluded from
 * the bundle (see src/vendor/hogan.stub.ts), so the custom templates are
 * implemented directly as render functions instead of template strings. Each
 * function reproduces its historical mustache source byte for byte, including
 * hogan's coercion, escaping, and section semantics; the equivalence is
 * pinned by tests/diff2html-templates.helper.test.ts, which renders the same
 * diffs through hogan-compiled raw templates and through these functions and
 * compares the output.
 */

/** The view diff2html passes to the file-diff template in line-by-line mode. */
interface LineFileDiffView {
  diffs?: string;
}

/** The view diff2html passes to the file-diff template in side-by-side mode. */
interface SideFileDiffView {
  diffs?: {
    left?: string;
    right?: string;
  };
}

/** The view diff2html passes to the generic wrapper template. */
interface WrapperView {
  content?: string;
}

/** The view diff2html passes to the hunk header template. */
interface BlockHeaderView {
  CSSLineClass?: {
    INFO?: string;
  };
  blockHeader?: string;
}

/** The view diff2html passes to the per-line template. */
interface GenericLineView {
  type?: string;
  lineNumber?: string | number;
  prefix?: string;
  content?: string;
}

/**
 * Mirrors hogan's string coercion: null and undefined render as an empty
 * string, everything else through String().
 *
 * @param {string | number | null} [value] - The view value to coerce
 * @return {string} The coerced string
 */
function raw(value?: string | number | null): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Mirrors hogan's HTML escape: the same characters, entity forms, and
 * replacement order as its `hoganEscape`.
 *
 * @param {string} [value] - The view value to escape
 * @return {string} The escaped string
 */
function esc(value?: string): string {
  return raw(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders the line prefix span: the raw prefix when present (a mustache
 * `{{#prefix}}` section, where an empty string counts as absent), the
 * non-breaking-space placeholder otherwise.
 *
 * @param {string} [prefix] - The line prefix (`+`, `-`, a space, or `&nbsp;`)
 * @return {string} The prefix span markup
 */
function prefixSpan(prefix?: string): string {
  return prefix
    ? `<span class="d2h-code-line-prefix">${prefix}</span>`
    : '<span class="d2h-code-line-prefix">&nbsp;</span>';
}

/**
 * Renders the line content span: the raw (upstream-escaped) content when
 * present, the `<br>` placeholder diff2html uses for empty lines otherwise.
 *
 * @param {string} [content] - The pre-escaped line content
 * @return {string} The content span markup
 */
function contentSpan(content?: string): string {
  return content
    ? `<span class="d2h-code-line-ctn">${content}</span>`
    : '<span class="d2h-code-line-ctn"><br></span>';
}

/**
 * Renders the generic wrapper: the plugin's replacement drops diff2html's
 * file header chrome and tags the root with the view mode so the stylesheet
 * can target each mode independently.
 *
 * @param {'line' | 'side'} mode - The output format marker class suffix
 * @param {WrapperView} view - The wrapper view
 * @return {string} The wrapper markup
 */
function renderWrapper(mode: 'line' | 'side', view: WrapperView): string {
  return `
        <div class="d2h-wrapper d2h-${mode}">
          <div class="d2h-container">
              ${raw(view.content)}
          </div>
        </div>
      `;
}

/**
 * Renders the hunk header row: the block header text when present, a
 * non-breaking space otherwise, matching the historical mustache section
 * `{{#blockHeader}}{{{blockHeader}}}{{/blockHeader}}{{^blockHeader}}&nbsp;{{/blockHeader}}`.
 *
 * @param {BlockHeaderView} view - The hunk header view
 * @return {string} The hunk header row markup
 */
function renderBlockHeader(view: BlockHeaderView): string {
  const info: string = esc(view.CSSLineClass?.INFO);

  return `
        <div class="d2h-code-row-wrapper d2h-code-header-wrapper ${info}">
            <div class="d2h-code-linenumber ${info}"></div>
            <div class="d2h-code-linecontent ${info}">
                <div class="d2h-code-line d2h-code-row">
                  <span class="d2h-code-line-prefix">&nbsp;</span>
                  <span class="d2h-code-line-ctn">
                    ${view.blockHeader ? raw(view.blockHeader) : '&nbsp;'}
                  </span>
                </div>
            </div>
        </div>
      `;
}

/**
 * Renders one diff line row: the plugin's replacement swaps diff2html's table
 * markup for divs so the rows flex inside the modal layout.
 *
 * @param {GenericLineView} view - The line view
 * @return {string} The line row markup
 */
function renderLine(view: GenericLineView): string {
  const type: string = esc(view.type);

  return `
        <div class="d2h-code-row-wrapper ${type}">
          <div class="d2h-code-linenumber ${type}">
            ${raw(view.lineNumber)}
          </div>
          <div class="d2h-code-linecontent ${type}">
              <div class="d2h-code-line d2h-code-row">
                    ${prefixSpan(view.prefix)}
                    ${contentSpan(view.content)}
              </div>
          </div>
      </div>
      `;
}

/** The custom templates for the line-by-line diff2html output format. */
export const DIFF2HTML_TEMPLATES_LINE = {
  'line-by-line-file-diff': {
    render: (view: LineFileDiffView): string => `
         ${raw(view.diffs)}
      `,
  },
  'generic-wrapper': {
    render: (view: WrapperView): string => renderWrapper('line', view),
  },
  'generic-block-header': {
    render: renderBlockHeader,
  },
  'generic-line': {
    render: renderLine,
  },
};

/** The custom templates for the side-by-side diff2html output format. */
export const DIFF2HTML_TEMPLATES_SIDE = {
  'side-by-side-file-diff': {
    render: (view: SideFileDiffView): string => `
        <div class="d2h-side-column">
          <div class="d2h-side-column-wrapper">
              <div class="d2h-side-column-container">
                ${raw(view.diffs?.left)}
            </div>
          </div>
        </div>
        <div class="d2h-side-column">
          <div class="d2h-side-column-wrapper">
              <div class="d2h-side-column-container">
                ${raw(view.diffs?.right)}
            </div>
          </div>
        </div>
      `,
  },
  'generic-wrapper': {
    render: (view: WrapperView): string => renderWrapper('side', view),
  },
  'generic-block-header': {
    render: renderBlockHeader,
  },
  'generic-line': {
    render: renderLine,
  },
};
