/**
 * Unit tests — escaping and the policy of the printable documents (2026-10-17
 * E2E S4-24b: the direct-issue slip wrote "<b>bold</b>" from General Remarks as markup).
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, PRINT_DOCUMENT_CSP, PRINT_DOCUMENT_CSP_META } from './html.js';

describe('escapeHtml', () => {
  it('escapes markup, entities and both quotes, so a value is safe in content and in a quoted attribute', () => {
    expect(escapeHtml('<b>bold</b> & co')).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; co');
    expect(escapeHtml('" onerror="alert(1)')).toBe('&quot; onerror=&quot;alert(1)');
    expect(escapeHtml("O'Brien")).toBe('O&#39;Brien');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('writes nothing for a missing value, and a number as itself', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(12.5)).toBe('12.5');
  });
});

describe('the print document policy', () => {
  it('lets a document style itself and show a data: logo, and nothing else', () => {
    expect(PRINT_DOCUMENT_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(PRINT_DOCUMENT_CSP).not.toMatch(/script-src|unsafe-eval/);
  });

  it('carries the same policy inside the document, without the directive a <meta> may not hold', () => {
    expect(PRINT_DOCUMENT_CSP_META).toBe(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" />`,
    );
  });
});
