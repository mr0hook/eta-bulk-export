// The row colour scheme, in ONE place.
//
// It used to live inside xlsx.js, which meant only the ExcelJS path (an ordinary chunk file) was
// coloured: the SPEC-027 detail part files and the SPEC-014 merged deliverables both go through the
// streaming writer and came out plain white. Same palette, same rule, three writers.
export const VALID = 'FFC6EFCE';    // green  — a valid document
export const CREDIT = 'FFD9E1F2';   // blue   — credit note (reverses value)
export const DEBIT = 'FFFFE699';    // yellow — debit note
export const BAD = 'FFFFC7CE';      // red    — invalid / rejected / cancelled

// The order here IS the style index in the streaming writer's fixed style table, so parts written
// by different runs stay interchangeable. Append only; never reorder.
export const ROW_FILLS = [VALID, CREDIT, DEBIT, BAD];

export const BAD_STATUS = ['Invalid', 'Rejected', 'Cancelled', 'Cancellation Requested', 'Rejection Requested'];

/** @returns {string|null} ARGB for a row, or null for no fill. */
export function fillArgb(statusEn, typeEn) {
  if (statusEn === 'Valid') return typeEn === 'Credit Note' ? CREDIT : typeEn === 'Debit Note' ? DEBIT : VALID;
  return BAD_STATUS.includes(statusEn) ? BAD : null;
}

/** The same thing as an ExcelJS fill object. */
export const solidFill = (argb) => (argb ? { type: 'pattern', pattern: 'solid', fgColor: { argb } } : null);
