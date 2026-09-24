/**
 * core — Transforms to a canonical numbering (docs/reconciliation.md §2.3)
 *
 * Build-time arithmetic is exact: rationals are `bigint`. Generated code
 * only ever sees the integer terms `affineTerms` hands it, which
 * `reconcile` bounds to 2^53 so a JS `number` holds them exactly.
 */

/** Normalized: `den > 0`, `gcd(num, den) = 1`. */
export interface Rational { readonly num: bigint; readonly den: bigint }

/** An integer, or a `[num, den]` pair. Numbers must be safe integers. */
export type RationalLike = number | bigint | readonly [number | bigint, number | bigint]

export type RoundingMode = "nearest-even" | "floor" | "ceil" | "toward-zero"

/** `c = scale·x + offset`. */
export interface Transform { readonly op: "affine"; readonly scale: Rational; readonly offset: Rational }

const abs = (n: bigint): bigint => n < 0n ? -n : n

function gcd(a: bigint, b: bigint): bigint
{
    a = abs(a); b = abs(b)
    while(b !== 0n) [a, b] = [b, a % b]
    return a
}

function bigOf(n: number | bigint): bigint
{
    if(typeof n === "bigint") return n
    if(!Number.isSafeInteger(n)) throw new Error(`transform: ${n} is not a safe integer — write a fraction as [num, den]`)
    return BigInt(n)
}

export function rational(num: bigint, den: bigint = 1n): Rational
{
    if(den === 0n) throw new Error("transform: zero denominator")
    const sign = den < 0n ? -1n : 1n
    const g = gcd(num, den) || 1n
    return { num: sign * num / g, den: sign * den / g }
}

export function toRational(r: RationalLike): Rational
{
    return typeof r === "object" ? rational(bigOf(r[0]), bigOf(r[1])) : rational(bigOf(r))
}

const add = (a: Rational, b: Rational): Rational => rational(a.num * b.den + b.num * a.den, a.den * b.den)
const sub = (a: Rational, b: Rational): Rational => rational(a.num * b.den - b.num * a.den, a.den * b.den)
const mul = (a: Rational, b: Rational): Rational => rational(a.num * b.num, a.den * b.den)
const div = (a: Rational, b: Rational): Rational => rational(a.num * b.den, a.den * b.num)

export const formatRational = (r: Rational): string => r.den === 1n ? `${r.num}` : `${r.num}/${r.den}`

export function affine(scale: RationalLike, offset: RationalLike = 0): Transform
{
    const s = toRational(scale)
    if(s.num === 0n) throw new Error("affine: scale is zero, so it cannot be inverted")
    return { op: "affine", scale: s, offset: toRational(offset) }
}

export const isIdentity = (t: Transform): boolean =>
    t.scale.num === 1n && t.scale.den === 1n && t.offset.num === 0n

/** `dst⁻¹ ∘ src`, from one numbering to the other; `undefined` when it is the identity. */
export function between(src: Transform | undefined, dst: Transform | undefined): Transform | undefined
{
    const one = rational(1n), zero = rational(0n)
    const [as, bs] = src ? [src.scale, src.offset] : [one, zero]
    const [ad, bd] = dst ? [dst.scale, dst.offset] : [one, zero]
    const g: Transform = { op: "affine", scale: div(as, ad), offset: div(sub(bs, bd), ad) }
    return isIdentity(g) ? undefined : g
}

export const evaluate = (t: Transform, x: number | bigint): Rational => add(mul(t.scale, rational(bigOf(x))), t.offset)

/** `t(x) = (mul·x + add) / div` with `div > 0`. */
export function affineTerms(t: Transform): { mul: bigint; add: bigint; div: bigint }
{
    const d = t.scale.den / gcd(t.scale.den, t.offset.den) * t.offset.den
    return { mul: t.scale.num * (d / t.scale.den), add: t.offset.num * (d / t.offset.den), div: d }
}

export const isExact = (t: Transform): boolean => affineTerms(t).div === 1n

export function round(r: Rational, mode: RoundingMode): bigint
{
    const q = r.num / r.den, rem = r.num % r.den
    if(rem === 0n) return q
    switch(mode)
    {
        case "toward-zero": return q
        case "floor": return rem < 0n ? q - 1n : q
        case "ceil": return rem > 0n ? q + 1n : q
        case "nearest-even":
        {
            const away = rem < 0n ? q - 1n : q + 1n
            const twice = 2n * abs(rem)
            if(twice !== r.den) return twice > r.den ? away : q
            return q % 2n === 0n ? q : away
        }
    }
}
