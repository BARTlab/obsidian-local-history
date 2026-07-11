import { DIFF2HTML_TEMPLATES_LINE, DIFF2HTML_TEMPLATES_SIDE } from '@/helpers/diff2html-templates.helper';
import * as Diff2Html from 'diff2html';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Equivalence tests for the hand-written diff2html templates. The historical
 * mustache sources live in tests/fixtures/diff2html-templates/; each diff is
 * rendered twice, once through diff2html's runtime hogan compilation of those
 * sources (`rawTemplates`) and once through the hand-written render functions
 * the plugin ships (`compiledTemplates`), and the HTML must match byte for
 * byte. This is what allows the bundle to exclude hogan's compiler (see
 * src/vendor/hogan.stub.ts) without changing the rendered DOM.
 */

const FIXTURE_DIR: string = resolve(__dirname, 'fixtures/diff2html-templates');

/** Reads one historical mustache source from the fixture directory. */
function source(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, `${name}.mustache`), 'utf8');
}

/** The generic wrapper source, parameterized by the output format marker. */
function wrapperSource(mode: 'line' | 'side'): string {
  return source('generic-wrapper').replace('__MODE__', mode);
}

const RAW_TEMPLATES_LINE: Record<string, string> = {
  'line-by-line-file-diff': source('line-by-line-file-diff'),
  'generic-wrapper': wrapperSource('line'),
  'generic-block-header': source('generic-block-header'),
  'generic-line': source('generic-line'),
};

const RAW_TEMPLATES_SIDE: Record<string, string> = {
  'side-by-side-file-diff': source('side-by-side-file-diff'),
  'generic-wrapper': wrapperSource('side'),
  'generic-block-header': source('generic-block-header'),
  'generic-line': source('generic-line'),
};

/**
 * The sample diffs cover every template branch: context/insert/delete rows,
 * an inserted empty line (the `<br>` placeholder), a deletion-only hunk (the
 * side-by-side empty placeholder cells), multiple hunks (repeated block
 * headers), and HTML-special characters flowing through the content path.
 */
const SAMPLE_DIFFS: Record<string, string> = {
  'modification': [
    '--- a/note.md',
    '+++ b/note.md',
    '@@ -1,3 +1,3 @@',
    ' first line',
    '-second line',
    '+second line changed',
    ' third line',
    '',
  ].join('\n'),
  'empty line insertion': [
    '--- a/note.md',
    '+++ b/note.md',
    '@@ -1,2 +1,3 @@',
    ' first line',
    '+',
    ' second line',
    '',
  ].join('\n'),
  'deletion only': [
    '--- a/note.md',
    '+++ b/note.md',
    '@@ -1,3 +1,1 @@',
    ' first line',
    '-second line',
    '-third line',
    '',
  ].join('\n'),
  'multiple hunks': [
    '--- a/note.md',
    '+++ b/note.md',
    '@@ -1,2 +1,2 @@',
    ' first line',
    '-second line',
    '+second line changed',
    '@@ -10,2 +10,2 @@',
    ' tenth line',
    '-eleventh line',
    '+eleventh line changed',
    '',
  ].join('\n'),
  'html special characters': [
    '--- a/note.md',
    '+++ b/note.md',
    '@@ -1,2 +1,2 @@',
    ' <div class="x">&amp;</div>',
    '-old \'quoted\' & <tagged>',
    '+new \'quoted\' & <tagged>',
    '',
  ].join('\n'),
};

/** Renders a diff with the shared production options and the given templates. */
function render(
  diff: string,
  format: 'line-by-line' | 'side-by-side',
  templates: { rawTemplates?: Record<string, string>; compiledTemplates?: unknown },
): string {
  return Diff2Html.html(diff, {
    drawFileList: false,
    matching: 'lines',
    outputFormat: format,
    renderNothingWhenEmpty: true,
    ...templates,
  } as Parameters<typeof Diff2Html.html>[1]);
}

describe('diff2html templates equivalence', () => {
  for (const [name, diff] of Object.entries(SAMPLE_DIFFS)) {
    it(`renders ${name} identically to the mustache sources in line-by-line mode`, () => {
      const expected: string = render(diff, 'line-by-line', { rawTemplates: RAW_TEMPLATES_LINE });
      const actual: string = render(diff, 'line-by-line', { compiledTemplates: DIFF2HTML_TEMPLATES_LINE });

      expect(actual).toBe(expected);
    });

    it(`renders ${name} identically to the mustache sources in side-by-side mode`, () => {
      const expected: string = render(diff, 'side-by-side', { rawTemplates: RAW_TEMPLATES_SIDE });
      const actual: string = render(diff, 'side-by-side', { compiledTemplates: DIFF2HTML_TEMPLATES_SIDE });

      expect(actual).toBe(expected);
    });
  }
});
