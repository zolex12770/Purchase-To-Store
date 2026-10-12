/**
 * Company/branding settings shared by every printable document (PO, GRN,
 * Requisition, Issue Slip). One loader, one shape — so a logo or address
 * change in Settings takes effect on every document the same way, and no
 * renderer can drift onto its own, slightly different company query.
 */
import { query } from '../db/index.js';
const KEYS = [
    'company.name', 'company.brand', 'company.tagline', 'company.address',
    'company.phone', 'company.fax', 'company.gst_no', 'company.logo_data_uri',
];
export async function loadCompanySettings() {
    const rows = await query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [KEYS]);
    const map = new Map(rows.map((r) => [r.key, typeof r.value === 'string' ? r.value : String(r.value ?? '')]));
    return {
        name: map.get('company.name') || 'Company',
        brand: map.get('company.brand') || '',
        tagline: map.get('company.tagline') || '',
        address: map.get('company.address') || '',
        phone: map.get('company.phone') || '',
        fax: map.get('company.fax') || '',
        gstNo: map.get('company.gst_no') || '',
        logoDataUri: map.get('company.logo_data_uri') || '',
    };
}
//# sourceMappingURL=company.js.map