/**
 * src/target-js/test — Transforms in generated code (docs/reconciliation.md
 * §2.3, §4.6, §5): the bridge converts between numberings, rounds per
 * `onInexact`, then applies `onOutOfDomain`.
 *
 * The origin's own module writes and reads the wire; the consumer's bridged
 * module is what is under test.
 */
import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import type { SemanticType } from "../../src/core/index"
import { affine, integer, list, named, struct } from "../../src/core/index"
import type { InexactPolicy } from "../../src/core/index"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, encodeCodecImage, decodeCodecImage } from "../../src/codecs/index"
import type { CodecImage } from "../../src/codecs/index"

import { generateBridgingCodecModule } from "../../src/target-js/engine/bridging-codec-module"
import { generateCodecModule } from "../../src/target-js/engine/codec-module"
import { loadGenerated } from "./load-generated"

function imageOf(rootType: SemanticType): CodecImage
{
    return {
        typeTree: rootType,
        encoderProgram: buildCodec(rootType, binaryEncodeRules, undefined),
        decoderProgram: buildCodec(rootType, binaryDecodeRules, undefined),
    }
}

type Codec = { encode: (v: any) => Uint8Array; decode: (b: Uint8Array) => any }

function plain(rootType: SemanticType): Codec
{
    const image = imageOf(rootType)
    const mod = loadGenerated(generateCodecModule({ name: "T", rootType, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
    return { encode: mod.encodeT, decode: mod.decodeT }
}

function bridged(imageType: SemanticType, localType: SemanticType, image = imageOf(imageType)): Codec
{
    const mod = loadGenerated(generateBridgingCodecModule({ name: "T", image, localType }))
    return { encode: mod.encodeT, decode: mod.decodeT }
}

/** Decode what the origin encoded, and what the consumer encodes as the origin reads it. */
function sides(imageType: SemanticType, localType: SemanticType)
{
    const origin = plain(imageType), consumer = bridged(imageType, localType)
    return {
        decode: (v: unknown) => consumer.decode(origin.encode(v)),
        encode: (v: unknown) => origin.decode(consumer.encode(v)),
    }
}

describe("rounding (§2.5 inexact)", () =>
{
    const half = named("T", struct({ v: integer(-10, 10, { meaning: "x:y", toCanonical: affine([1, 2]) }) }))
    const local = (mode: InexactPolicy) => named("T", struct({ v: integer(-5, 5, { meaning: "x:y", onInexact: mode }) }))

    test("every mode, on both signs and at the halves", () =>
    {
        const expected: Record<Exclude<InexactPolicy, "trap">, number[]> = {
            //                 x = -3  -1  1  3  4
            "nearest-even":     [-2,  0, 0, 2, 2],
            "floor":            [-2, -1, 0, 1, 2],
            "ceil":             [-1,  0, 1, 2, 2],
            "toward-zero":      [-1,  0, 0, 1, 2],
        }
        for(const [mode, ys] of Object.entries(expected))
        {
            const s = sides(half, local(mode as InexactPolicy))
            assert.deepEqual([-3, -1, 1, 3, 4].map(x => s.decode({ v: x }).v), ys, mode)
        }
    })

    test("trap rejects only what does not land on an integer", () =>
    {
        const s = sides(half, local("trap"))
        assert.deepEqual(s.decode({ v: -4 }), { v: -2 })
        assert.throws(() => s.decode({ v: 3 }), /inexact value at T\.v: 3\/2 is not an integer/)
    })

    test("the inverse is exact, so encode needs no policy", () =>
    {
        const s = sides(half, named("T", struct({ v: integer(-5, 5, { meaning: "x:y", onInexact: { decode: "trap" } }) })))
        assert.deepEqual(s.encode({ v: -3 }), { v: -6 })
    })
})

describe("Appendix A conversions", () =>
{
    test("ADC counts ↔ millivolts: rounded, then saturated", () =>
    {
        const adc = named("T", struct({ v: integer(0, 4095, { meaning: "si:voltage", toCanonical: affine([1, 2048], [5, 2]) }) }))
        const mv = named("T", struct({ v: integer(2500, 4200, { meaning: "si:voltage", toCanonical: affine([1, 1000]), onInexact: "nearest-even", onOutOfDomain: "saturate" }) }))
        const s = sides(adc, mv)
        assert.deepEqual([0, 1, 2, 256, 1024, 3480, 3500, 4095].map(x => s.decode({ v: x }).v), [2500, 2500, 2501, 2625, 3000, 4199, 4200, 4200])
        assert.deepEqual([2500, 3000, 4200].map(y => s.encode({ v: y }).v), [0, 1024, 3482])
    })

    test("deci-Celsius ↔ millikelvin: total one way, trapping the other", () =>
    {
        const dc = named("T", struct({ v: integer(-400, 1250, { meaning: "si:temperature", toCanonical: affine([1, 10], [5463, 20]) }) }))
        const mk = named("T", struct({ v: integer(233150, 398150, { meaning: "si:temperature", toCanonical: affine([1, 1000]), onInexact: "trap" }) }))
        const s = sides(dc, mk)
        assert.deepEqual([-400, 215, 1250].map(x => s.decode({ v: x }).v), [233150, 294650, 398150])
        assert.deepEqual(s.encode({ v: 294650 }), { v: 215 })
        assert.throws(() => s.encode({ v: 294651 }), /inexact value at T\.v/)
    })

    test("NTP ↔ Unix seconds: an epoch shift, out of domain before 1970 and after 2106", () =>
    {
        const ntp = named("T", struct({ v: integer(0, 2 ** 32 - 1, { meaning: "time:utc-instant", toCanonical: affine(1, -2208988800) }) }))
        const unix = named("T", struct({ v: integer(0, 2 ** 32 - 1, { meaning: "time:utc-instant", onOutOfDomain: "trap" }) }))
        const s = sides(ntp, unix)
        assert.deepEqual(s.decode({ v: 3913056000 }), { v: 1704067200 })
        assert.throws(() => s.decode({ v: 100 }), /out of domain at T\.v: -2208988700 is outside 0\.\.4294967295/)
        assert.deepEqual(s.encode({ v: 1704067200 }), { v: 3913056000 })
        assert.throws(() => s.encode({ v: 2085978496 }), /out of domain at T\.v/)
    })

    test("binary angle measure → degrees × 1e7: products near 2^53 stay exact", () =>
    {
        const bam = named("T", struct({ v: integer(-(2 ** 31), 2 ** 31 - 1, { meaning: "geo:longitude", toCanonical: affine([45, 2 ** 29]) }) }))
        const deg = named("T", struct({ v: integer(-1800000000, 1800000000, { meaning: "geo:longitude", toCanonical: affine([1, 10 ** 7]), onInexact: "nearest-even", onOutOfDomain: { encode: "saturate" } }) }))
        const s = sides(bam, deg)
        assert.deepEqual([-(2 ** 31), 2 ** 30, 2 ** 31 - 1, 1].map(x => s.decode({ v: x }).v), [-1800000000, 900000000, 1799999999, 1])
        assert.deepEqual([900000000, 1800000000].map(y => s.encode({ v: y }).v), [2 ** 30, 2 ** 31 - 1])
    })
})

describe("lists and the image wire", () =>
{
    test("a converting element edge takes the per-element path both ways", () =>
    {
        const image = named("T", list(integer(-10, 10, { meaning: "x:y", toCanonical: affine([1, 2]) }), { maxLength: 4 }))
        const local = named("T", list(integer(-5, 5, { meaning: "x:y", onInexact: "nearest-even" }), { maxLength: 4 }))
        const s = sides(image, local)
        assert.deepEqual(s.decode([1, 2, 3, 4]), [0, 1, 2, 2])
        assert.deepEqual(s.encode([1, -2]), [2, -4])
    })

    test("the transform survives the serialized image", () =>
    {
        const adc = named("T", struct({ v: integer(0, 4095, { meaning: "si:voltage", toCanonical: affine([1, 2048], [5, 2]) }) }))
        const mv = named("T", struct({ v: integer(2500, 4200, { meaning: "si:voltage", toCanonical: affine([1, 1000]), onInexact: "floor", onOutOfDomain: "saturate" }) }))
        const consumer = bridged(adc, mv, decodeCodecImage(encodeCodecImage(imageOf(adc))))
        assert.deepEqual(consumer.decode(plain(adc).encode({ v: 2 })), { v: 2500 })
    })
})
