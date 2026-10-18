/**
 * Printable HTML documents (requisition slip, issue slip, direct-issue slip):
 * escaping, and the response they are sent in.
 *
 * These documents carry what users typed (item descriptions, remarks, names) and
 * are served as text/html from the API's own origin. The direct-issue slip once
 * wrote its values in raw: General Remarks typed as "<b>bold</b>" came back as
 * markup (2026-10-17 E2E S4-24b), so anyone allowed to post a direct issue could
 * have stored a script for whoever printed the slip next. Two layers now stand in
 * the way: every value is escaped, and the document may not run or load anything.
 */
import type { Response } from 'express';

/** Escapes text for element content and for quoted attribute values alike. */
export function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** What a printable document needs: its own inline styles and the data: logo. Nothing else. */
const DOCUMENT_POLICY = ["default-src 'none'", "style-src 'unsafe-inline'", 'img-src data:', "base-uri 'none'", "form-action 'none'"];

/**
 * The policy sent with a document opened straight from its API URL. It is
 * switched off for the API as a whole (app.ts: the API otherwise serves JSON),
 * so the print routes send their own.
 */
export const PRINT_DOCUMENT_CSP = [...DOCUMENT_POLICY, "frame-ancestors 'none'"].join('; ');

/**
 * The same policy inside the document. The screens show these documents through
 * an iframe's srcdoc, which no response header reaches; a <meta> policy travels
 * with the markup (frame-ancestors is not allowed in a <meta>, so it is left out).
 */
export const PRINT_DOCUMENT_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_POLICY.join('; ')}" />`;

/** Sends a printable document with its policy. */
export function sendPrintDocument(res: Response, html: string): void {
  res.setHeader('Content-Security-Policy', PRINT_DOCUMENT_CSP);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
