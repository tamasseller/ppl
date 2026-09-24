/**
 * Runtime tests for transforms (docs/reconciliation.md §2.3): exact
 * rationals, composition between two numberings, exactness and rounding.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {affine, affineTerms, between, evaluate, isExact, rational, round} from "../../src/core/transform"

test("affine: a zero scale and a non-integer number are refused", () => {
    assert.throws(() => affine(0), /scale is zero/)
    assert.throws(() => affine(0.001), /not a safe integer/)
    assert.throws(() => affine([1, 0]), /zero denominator/)
})

test("between: dst⁻¹ ∘ src, and the identity is undefined", () => {
    const adc = affine([1, 2048], [5, 2])
    const mv = affine([1, 1000])
    assert.deepEqual(between(adc, mv), {op: "affine", scale: rational(125n, 256n), offset: rational(2500n)})
    assert.deepEqual(between(mv, adc), {op: "affine", scale: rational(256n, 125n), offset: rational(-5120n)})
    assert.equal(between(adc, adc), undefined)
    assert.equal(between(undefined, undefined), undefined)
    assert.deepEqual(between(undefined, mv), {op: "affine", scale: rational(1000n), offset: rational(0n)})
})

test("affineTerms: one common denominator", () => {
    assert.deepEqual(affineTerms(affine([1, 6], [1, 4])), {mul: 2n, add: 3n, div: 12n})
    assert.deepEqual(affineTerms(affine(-3, 7)), {mul: -3n, add: 7n, div: 1n})
})

test("isExact: integer scale and offset", () => {
    assert.equal(isExact(affine(100, 273150)), true)
    assert.equal(isExact(affine(2, [1, 2])), false)
    assert.equal(isExact(affine([1, 10])), false)
})

test("round: every mode, on both signs", () => {
    const cases: [bigint, bigint, bigint, bigint, bigint, bigint][] = [
        //  num  den  nearest-even floor ceil toward-zero
        [5n, 2n, 2n, 2n, 3n, 2n],
        [7n, 2n, 4n, 3n, 4n, 3n],
        [-5n, 2n, -2n, -3n, -2n, -2n],
        [-7n, 2n, -4n, -4n, -3n, -3n],
        [7n, 3n, 2n, 2n, 3n, 2n],
        [-8n, 3n, -3n, -3n, -2n, -2n],
        [6n, 3n, 2n, 2n, 2n, 2n],
    ]
    for(const [num, den, ne, fl, ce, tz] of cases)
    {
        const r = rational(num, den)
        assert.deepEqual([round(r, "nearest-even"), round(r, "floor"), round(r, "ceil"), round(r, "toward-zero")], [ne, fl, ce, tz], `${num}/${den}`)
    }
})

test("evaluate: exact at the ends of a domain", () => {
    assert.deepEqual(evaluate(affine([125, 256], 2500), 4095), rational(1151875n, 256n))
})
