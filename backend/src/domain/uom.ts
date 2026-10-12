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
