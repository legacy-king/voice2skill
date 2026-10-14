/** Kobo (integer) -> "₦5,000" / "₦1,234.50". Display only — never parse this back. */
function naira(kobo) {
  const n = Number(kobo || 0) / 100;
  const hasFraction = Math.round(n * 100) % 100 !== 0;
  return '₦' + n.toLocaleString('en-NG', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2
  });
}

/** Whole-naira user input ("5,000", "₦5000") -> kobo integer, or null if invalid (fractions rejected). */
function nairaToKobo(input) {
  const cleaned = String(input).replace(/[,\s₦]/g, '');
  if (!/^\d{1,7}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n > 1_000_000 ? null : n * 100;
}

module.exports = { naira, nairaToKobo };
