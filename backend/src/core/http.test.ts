/**
 * Unit tests — the file name a document download is saved under (audit A7 F16).
 */
import { describe, it, expect } from 'vitest';
import { attachmentDisposition } from './http.js';

describe('attachmentDisposition', () => {
  it('names an imported purchase order without its slashes', () => {
    expect(attachmentDisposition('Z/PM/00368', 'pdf')).toBe('attachment; filename="Z-PM-00368.pdf"');
    expect(attachmentDisposition('GRN-20261017-0001', 'pdf')).toBe('attachment; filename="GRN-20261017-0001.pdf"');
  });

  it('drops quotes, and replaces path, reserved and header-breaking characters', () => {
    expect(attachmentDisposition('PO "A" 1', 'pdf')).toBe('attachment; filename="PO A 1.pdf"');
    expect(attachmentDisposition("Supplier's PO", 'pdf')).toBe('attachment; filename="Suppliers PO.pdf"');
    expect(attachmentDisposition('a\\b:c*d?e<f>g|h%i', 'pdf')).toBe('attachment; filename="a-b-c-d-e-f-g-h-i.pdf"');
    expect(attachmentDisposition('GRN–001', 'pdf')).toBe('attachment; filename="GRN-001.pdf"');
    const injected = attachmentDisposition('GRN\r\nSet-Cookie: x=1', 'pdf');
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toBe('attachment; filename="GRN-Set-Cookie- x=1.pdf"');
  });

  it('never names a folder, and never an empty name', () => {
    expect(attachmentDisposition('../../etc/passwd', 'pdf')).toBe('attachment; filename="etc-passwd.pdf"');
    expect(attachmentDisposition('', 'pdf')).toBe('attachment; filename="document.pdf"');
    expect(attachmentDisposition('///', 'pdf')).toBe('attachment; filename="document.pdf"');
  });
});
