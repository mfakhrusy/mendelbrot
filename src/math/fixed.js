// Coordinates are fixed-point BigInts with `bits` fractional bits.
// There is no fixed precision ceiling.

export function fromDecimal(text, bits) {
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const n = (BigInt(whole + fraction) << BigInt(bits)) / 10n ** BigInt(fraction.length);
  return negative ? -n : n;
}

export function toNumber(n, bits) {
  const shift = Math.max(0, bits - 54);
  return Number(n >> BigInt(shift)) * 2 ** (shift - bits);
}

// value * 2^exponent as a fixed-point integer, for exponents far below
// what a double can represent.
export function offsetInteger(value, exponent, bits) {
  const whole = Math.floor(exponent);
  const shift = bits + whole - 48;
  const mantissa = BigInt(Math.round(value * 2 ** (exponent - whole + 48)));
  return shift >= 0 ? mantissa << BigInt(shift) : mantissa >> BigInt(-shift);
}

// n / 2^(bits + exponent) as a double, keeping 50 significant bits of n.
export function relative(n, bits, exponent) {
  if (n === 0n) return 0;
  const negative = n < 0n;
  if (negative) n = -n;
  const shift = Math.max(0, n.toString(2).length - 50);
  return (negative ? -1 : 1) * Number(n >> BigInt(shift)) * 2 ** (shift - bits - exponent);
}
