/**
 * Standard Unit of Measure (UOM) normalization.
 *
 * All Unit of Measure selectors and displays must use approved short forms
 * rather than long descriptive names (Requirement 8).
 */

const UOM_SHORT_MAP: Record<string, string> = {
  // Numbers / Pieces / Sets
  'NUMBERS': 'Nos',
  'NUMBER': 'Nos',
  'NOS': 'Nos',
  'NOS.': 'Nos',
  'NO.': 'Nos',
  'NO': 'Nos',
  'PIECES': 'Pcs',
  'PIECE': 'Pcs',
  'PCS': 'Pcs',
  'PCS.': 'Pcs',
  'PC': 'Pcs',
  'PC.': 'Pcs',
  'SET': 'Set',
  'SETS': 'Set',
  'PAIR': 'Pair',
  'PAIRS': 'Pair',
  'PR': 'Pair',

  // Weight / Mass
  'KILOGRAM': 'Kg',
  'KILOGRAMS': 'Kg',
  'KG': 'Kg',
  'KGS': 'Kg',
  'KG.': 'Kg',
  'GRAM': 'Gm',
  'GRAMS': 'Gm',
  'GM': 'Gm',
  'GMS': 'Gm',
  'GM.': 'Gm',
  'G': 'Gm',
  'TONNE': 'Ton',
  'TONNES': 'Ton',
  'TON': 'Ton',
  'TONS': 'Ton',
  'MT': 'Ton',

  // Length / Distance
  'METER': 'Mtr',
  'METERS': 'Mtr',
  'METRE': 'Mtr',
  'METRES': 'Mtr',
  'MTR': 'Mtr',
  'MTRS': 'Mtr',
  'MTR.': 'Mtr',
  'M': 'Mtr',
  'CENTIMETER': 'Cm',
  'CENTIMETERS': 'Cm',
  'CENTIMETRE': 'Cm',
  'CENTIMETRES': 'Cm',
  'CM': 'Cm',
  'MILLIMETER': 'Mm',
  'MILLIMETERS': 'Mm',
  'MILLIMETRE': 'Mm',
  'MILLIMETRES': 'Mm',
  'MM': 'Mm',
  'FEET': 'Ft',
  'FOOT': 'Ft',
  'FT': 'Ft',
  'INCH': 'Inch',
  'INCHES': 'Inch',
  'IN': 'Inch',

  // Volume
  'LITRE': 'Ltr',
  'LITRES': 'Ltr',
  'LITER': 'Ltr',
  'LITERS': 'Ltr',
  'LTR': 'Ltr',
  'LTRS': 'Ltr',
  'L': 'Ltr',
  'MILLILITRE': 'Ml',
  'MILLILITRES': 'Ml',
  'MILLILITER': 'Ml',
  'MILLILITERS': 'Ml',
  'ML': 'Ml',

  // Area
  'SQUARE METER': 'Sqm',
  'SQUARE METERS': 'Sqm',
  'SQUARE METRE': 'Sqm',
  'SQM': 'Sqm',
  'SQ.MTR': 'Sqm',
  'SQ MTR': 'Sqm',
  'SQ. MTR': 'Sqm',

  // Packaging / Commercial containers
  'BOX': 'Box',
  'BOXES': 'Box',
  'ROLL': 'Roll',
  'ROLLS': 'Roll',
  'PACKET': 'Pkt',
  'PACKETS': 'Pkt',
  'PKT': 'Pkt',
  'PKTS': 'Pkt',
  'COIL': 'Coil',
  'COILS': 'Coil',
  'BUNDLE': 'Bdl',
  'BUNDLES': 'Bdl',
  'BDL': 'Bdl',
  'CAN': 'Can',
  'CANS': 'Can',
  'BAG': 'Bag',
  'BAGS': 'Bag',
  'DRUM': 'Drum',
  'DRUMS': 'Drum',
  'BOTTLE': 'Btl',
  'BOTTLES': 'Btl',
  'BTL': 'Btl',
  'TUBE': 'Tube',
  'TUBES': 'Tube',
  'SHEET': 'Sheet',
  'SHEETS': 'Sheet',
  'LOT': 'Lot',
  'LOTS': 'Lot',
};

/**
 * Converts a raw UOM name, code, or alias to the approved short form.
 */
export function toShortUom(raw?: string | null): string {
  if (!raw) return '';
  const clean = raw.trim();
  if (!clean) return '';
  const key = clean.toUpperCase().replace(/\s+/g, ' ');
  return UOM_SHORT_MAP[key] ?? clean;
}

/**
 * Whether quantities recorded in units `a` and `b` may be added together.
 *
 * Letter case and the usual spellings are ignored ("KG" = "Kg" = "KGS", "MTR" =
 * "Mtr" = "M"), and the counted units Nos / No / Pcs / Pc are one unit: the Item
 * Master and the store sheets use them interchangeably for the same items. A
 * missing unit matches nothing, so a figure of unknown unit is never added to
 * another. (Until 2026-10-16 the inventory sync added PTC4/0's 1,472 Nos from the
 * WIP sheet to its 264.75 Kg from the RM sheet.)
 */
export function sameUnit(a?: string | null, b?: string | null): boolean {
  const key = (raw?: string | null) => {
    const short = toShortUom(raw);
    return (short === 'Pcs' ? 'Nos' : short).toUpperCase();
  };
  const ka = key(a);
  return ka !== '' && ka === key(b);
}
