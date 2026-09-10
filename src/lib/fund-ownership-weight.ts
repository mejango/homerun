/** Exact ownership ratios. They remain offchain evidence, never floating-point amounts. */
export type FundOwnershipWeight = { numerator: bigint; denominator: bigint }

export function ownershipWeight(numerator: bigint, denominator = 1n): FundOwnershipWeight {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || numerator < 0n || denominator <= 0n) throw new Error('An ownership weight requires a nonnegative numerator and positive denominator.')
  let left = numerator, right = denominator
  while (right !== 0n) { const remainder = left % right; left = right; right = remainder }
  return { numerator: numerator / left, denominator: denominator / left }
}
export function addOwnershipWeights(left: FundOwnershipWeight, right: FundOwnershipWeight): FundOwnershipWeight {
  const a = ownershipWeight(left.numerator, left.denominator), b = ownershipWeight(right.numerator, right.denominator)
  return ownershipWeight(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator)
}
export function multiplyOwnershipWeight(value: FundOwnershipWeight, numerator: bigint, denominator = 1n): FundOwnershipWeight {
  const normalized = ownershipWeight(value.numerator, value.denominator), factor = ownershipWeight(numerator, denominator)
  return ownershipWeight(normalized.numerator * factor.numerator, normalized.denominator * factor.denominator)
}
export function sumOwnershipWeights(values: readonly FundOwnershipWeight[]): FundOwnershipWeight {
  return values.reduce(addOwnershipWeights, ownershipWeight(0n))
}
