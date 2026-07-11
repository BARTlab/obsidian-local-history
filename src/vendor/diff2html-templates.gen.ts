// @ts-nocheck
/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Precompiled diff2html templates. Sources live in
 * scripts/diff2html-templates/*.mustache; regenerate with:
 *   node scripts/compile-diff2html-templates.mjs
 *
 * Precompilation keeps hogan's `new Function`-based compiler out of the
 * bundle (see src/vendor/hogan.stub.ts); only the render-only Template
 * runtime ships.
 */
import { Template } from '@profoundlogic/hogan/lib/template.js';

const lineByLineFileDiff = new Template({code: function (c,p,i) { var t=this;t.b(i=i||"");t.b("\n" + i);t.b("         ");t.b(t.t(t.f("diffs",c,p,0)));t.b("\n" + i);t.b("      ");return t.fl(); },partials: {}, subs: {  }});
const sideBySideFileDiff = new Template({code: function (c,p,i) { var t=this;t.b(i=i||"");t.b("\n" + i);t.b("        <div class=\"d2h-side-column\">");t.b("\n" + i);t.b("          <div class=\"d2h-side-column-wrapper\">");t.b("\n" + i);t.b("              <div class=\"d2h-side-column-container\">");t.b("\n" + i);t.b("                ");t.b(t.t(t.d("diffs.left",c,p,0)));t.b("\n" + i);t.b("            </div>");t.b("\n" + i);t.b("          </div>");t.b("\n" + i);t.b("        </div>");t.b("\n" + i);t.b("        <div class=\"d2h-side-column\">");t.b("\n" + i);t.b("          <div class=\"d2h-side-column-wrapper\">");t.b("\n" + i);t.b("              <div class=\"d2h-side-column-container\">");t.b("\n" + i);t.b("                ");t.b(t.t(t.d("diffs.right",c,p,0)));t.b("\n" + i);t.b("            </div>");t.b("\n" + i);t.b("          </div>");t.b("\n" + i);t.b("        </div>");t.b("\n" + i);t.b("      ");return t.fl(); },partials: {}, subs: {  }});
const genericWrapperLine = new Template({code: function (c,p,i) { var t=this;t.b(i=i||"");t.b("\n" + i);t.b("        <div class=\"d2h-wrapper d2h-line\">");t.b("\n" + i);t.b("          <div class=\"d2h-container\">");t.b("\n" + i);t.b("              ");t.b(t.t(t.f("content",c,p,0)));t.b("\n" + i);t.b("          </div>");t.b("\n" + i);t.b("        </div>");t.b("\n" + i);t.b("      ");return t.fl(); },partials: {}, subs: {  }});
const genericWrapperSide = new Template({code: function (c,p,i) { var t=this;t.b(i=i||"");t.b("\n" + i);t.b("        <div class=\"d2h-wrapper d2h-side\">");t.b("\n" + i);t.b("          <div class=\"d2h-container\">");t.b("\n" + i);t.b("              ");t.b(t.t(t.f("content",c,p,0)));t.b("\n" + i);t.b("          </div>");t.b("\n" + i);t.b("        </div>");t.b("\n" + i);t.b("      ");return t.fl(); },partials: {}, subs: {  }});
const genericBlockHeader = new Template({code: function (c,p,i) { var t=this;t.b(i=i||"");t.b("\n" + i);t.b("        <div class=\"d2h-code-row-wrapper d2h-code-header-wrapper ");t.b(t.v(t.d("CSSLineClass.INFO",c,p,0)));t.b("\">");t.b("\n" + i);t.b("            <div class=\"d2h-code-linenumber ");t.b(t.v(t.d("CSSLineClass.INFO",c,p,0)));t.b("\"></div>");t.b("\n" + i);t.b("            <div class=\"d2h-code-linecontent ");t.b(t.v(t.d("CSSLineClass.INFO",c,p,0)));t.b("\">");t.b("\n" + i);t.b("                <div class=\"d2h-code-line d2h-code-row\">");t.b("\n" + i);t.b("                  <span class=\"d2h-code-line-prefix\">&nbsp;</span>");t.b("\n" + i);t.b("                  <span class=\"d2h-code-line-ctn\">");t.b("\n" + i);t.b("                    ");if(t.s(t.f("blockHeader",c,p,1),c,p,0,444,461,"{{ }}")){t.rs(c,p,function(c,p,t){t.b(t.t(t.f("blockHeader",c,p,0)));});c.pop();}if(!t.s(t.f("blockHeader",c,p,1),c,p,1,0,0,"")){t.b("&nbsp;");};t.b("\n" + i);t.b("                  </span>");t.b("\n" + i);t.b("                </div>");t.b("\n" + i);t.b("            </div>");t.b("\n" + i);t.b("        </div>");t.b("\n" + i);t.b("      ");return t.fl(); },partials: {}, subs: {  }});
const genericLine = new Template({code: function (c,p,i) { var t=this;t.b(i=i||"");t.b("\n" + i);t.b("        <div class=\"d2h-code-row-wrapper ");t.b(t.v(t.f("type",c,p,0)));t.b("\">");t.b("\n" + i);t.b("          <div class=\"d2h-code-linenumber ");t.b(t.v(t.f("type",c,p,0)));t.b("\">");t.b("\n" + i);t.b("            ");t.b(t.t(t.f("lineNumber",c,p,0)));t.b("\n" + i);t.b("          </div>");t.b("\n" + i);t.b("          <div class=\"d2h-code-linecontent ");t.b(t.v(t.f("type",c,p,0)));t.b("\">");t.b("\n" + i);t.b("              <div class=\"d2h-code-line d2h-code-row\">");t.b("\n" + i);if(t.s(t.f("prefix",c,p,1),c,p,0,288,380,"{{ }}")){t.rs(c,p,function(c,p,t){t.b("                    <span class=\"d2h-code-line-prefix\">");t.b(t.t(t.f("prefix",c,p,0)));t.b("</span>");t.b("\n" + i);});c.pop();}if(!t.s(t.f("prefix",c,p,1),c,p,1,0,0,"")){t.b("                    <span class=\"d2h-code-line-prefix\">&nbsp;</span>");t.b("\n" + i);};if(t.s(t.f("content",c,p,1),c,p,0,545,635,"{{ }}")){t.rs(c,p,function(c,p,t){t.b("                    <span class=\"d2h-code-line-ctn\">");t.b(t.t(t.f("content",c,p,0)));t.b("</span>");t.b("\n" + i);});c.pop();}if(!t.s(t.f("content",c,p,1),c,p,1,0,0,"")){t.b("                    <span class=\"d2h-code-line-ctn\"><br></span>");t.b("\n" + i);};t.b("              </div>");t.b("\n" + i);t.b("          </div>");t.b("\n" + i);t.b("      </div>");t.b("\n" + i);t.b("      ");return t.fl(); },partials: {}, subs: {  }});

/** The custom templates for the line-by-line diff2html output format. */
export const DIFF2HTML_TEMPLATES_LINE: Record<string, Template> = {
  'line-by-line-file-diff': lineByLineFileDiff,
  'generic-wrapper': genericWrapperLine,
  'generic-block-header': genericBlockHeader,
  'generic-line': genericLine,
};

/** The custom templates for the side-by-side diff2html output format. */
export const DIFF2HTML_TEMPLATES_SIDE: Record<string, Template> = {
  'side-by-side-file-diff': sideBySideFileDiff,
  'generic-wrapper': genericWrapperSide,
  'generic-block-header': genericBlockHeader,
  'generic-line': genericLine,
};
