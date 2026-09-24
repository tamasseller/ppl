/**
 * src/codecs/test — Type tree wire encoding (engine/type-tree-wire.ts,
 * docs/codec-image.md §3)
 *
 * Mirrors `wire.test.ts`'s own approach: representative exact-byte checks
 * for each opcode family, plus structural round trips (decode can't
 * reproduce the exact same JS objects the encoder started from, so
 * equivalence is checked shape-by-shape, not `deepEqual` on identity).
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { IntegerType, SemanticType, StructType } from "../../src/core/index"
import {
    SemanticTypeKinds, bytes as fixedBytes, derefType, i16, i32, i8, integer, list, struct, u16, u32, u8, union, unit,
} from "../../src/core/index"

import { decodeTypeTree, encodeTypeTree } from "../../src/codecs/engine/type-tree-wire"

function sameShape(a: SemanticType, b: SemanticType): void
{
    const ta = derefType(a), tb = derefType(b)
    assert.equal(ta.kind, tb.kind)
    switch(ta.kind)
    {
        case SemanticTypeKinds.Unit: break
        case SemanticTypeKinds.Integer:
        {
            const bi = tb as typeof ta
            assert.deepEqual({ min: ta.min, max: ta.max, default: ta.default, meaning: ta.meaning }, { min: bi.min, max: bi.max, default: bi.default, meaning: bi.meaning })
            break
        }
        case SemanticTypeKinds.List:
        {
            const bl = tb as typeof ta
            assert.deepEqual([ta.minLength, ta.maxLength], [bl.minLength, bl.maxLength])
            sameShape(ta.elementType, bl.elementType)
            break
        }
        case SemanticTypeKinds.Struct:
        {
            const bs = tb as typeof ta
            assert.deepEqual([...ta.fields.keys()], [...bs.fields.keys()])
            for(const name of ta.fields.keys()) sameShape(ta.fields.get(name)!, bs.fields.get(name)!)
            break
        }
        case SemanticTypeKinds.Union:
        {
            const bu = tb as typeof ta
            assert.deepEqual([...ta.variants.keys()], [...bu.variants.keys()])
            assert.equal(ta.defaultVariant, bu.defaultVariant)
            for(const name of ta.variants.keys()) sameShape(ta.variants.get(name)!, bu.variants.get(name)!)
            break
        }
    }
}

function roundTrip(t: SemanticType): { bytes: Uint8Array; decoded: SemanticType }
{
    const bytes = encodeTypeTree(t)
    const { type, next } = decodeTypeTree(bytes)
    assert.equal(next, bytes.length, "decode must consume exactly what encode produced")
    sameShape(t, type)
    return { bytes, decoded: type }
}

describe("type tree wire — leaves", () =>
{
    test("unit", () => { roundTrip(unit) })

    test("every canonical width with no default costs exactly one tag byte, no operands", () =>
    {
        for(const [t, tag] of [[u8, 0xC1], [i8, 0xC2], [u16, 0xC3], [i16, 0xC4], [u32, 0xC5], [i32, 0xC6]] as const)
        {
            const { bytes } = roundTrip(t)
            // string table: count=0 (1 byte) + tag + END
            assert.deepEqual([...bytes], [0, tag, 0xD0])
        }
    })

    test("a canonical range with a default is not a canonical tag", () =>
    {
        const { bytes } = roundTrip(integer(0, 255, {default: 0}))
        assert.deepEqual([...bytes], [0, 0xC8, ...[0xFF, 0x01], 0, 0xD0]) // max=255, default=0
    })

    test("min=0, no default uses the 1-operand extended form", () =>
    {
        const { bytes } = roundTrip(integer(0, 1000))
        assert.deepEqual([...bytes], [0, 0xC7, ...[0xE8, 0x07], 0xD0]) // max=1000 LEB128
    })

    test("min=0 with a default uses the 2-operand extended form", () =>
    {
        const { bytes } = roundTrip(integer(0, 1000, {default: 7}))
        assert.deepEqual([...bytes], [0, 0xC8, ...[0xE8, 0x07], 14, 0xD0]) // default=7 zigzag
    })

    test("non-zero min, no default uses the 2-operand (min,max) extended form", () =>
    {
        const { bytes } = roundTrip(integer(-40, 125))
        assert.deepEqual([...bytes], [0, 0xC9, 79, ...[0xFA, 0x01], 0xD0]) // min=-40, max=125 zigzag
    })

    test("non-zero min with a default uses the fully general extended form", () =>
    {
        const { bytes } = roundTrip(integer(-40, 125, {default: 20}))
        assert.deepEqual([...bytes], [0, 0xCA, 79, ...[0xFA, 0x01], 40, 0xD0])
    })

    test("a meaning is a MEANING postfix on the integer, naming a string-table entry", () =>
    {
        const { bytes } = roundTrip(integer(0, 255, {meaning: "si:voltage"}))
        const utf8 = [...new TextEncoder().encode("si:voltage")]
        assert.deepEqual([...bytes], [1, utf8.length, ...utf8, 0xC1, 0xD1, 0, 0xD0])
    })

    test("MEANING is its own construction: dedup keeps the plain and the meaningful integer apart", () =>
    {
        const V = integer(0, 255, {meaning: "si:voltage"})
        const { bytes, decoded } = roundTrip(struct({ a: V, b: integer(0, 255, {meaning: "si:voltage"}), c: u8 }))
        const s = derefType(decoded) as StructType
        assert.equal((derefType(s.fields.get("b")!) as IntegerType).meaning, "si:voltage")
        assert.equal((derefType(s.fields.get("c")!) as IntegerType).meaning, undefined)
        // b refers back 1 construction (the MEANING), c refers back 2 (the plain u8 under it)
        const i = [...bytes].indexOf(0xD1)
        assert.deepEqual([...bytes].slice(i, i + 4), [0xD1, 0, 0x80, 0x81])
    })

    test("two meanings over one range are not merged", () =>
    {
        roundTrip(struct({ a: integer(0, 255, {meaning: "si:voltage"}), b: integer(0, 255, {meaning: "si:power"}) }))
    })

    test("MEANING on anything but an integer is rejected", () =>
    {
        assert.throws(() => decodeTypeTree(Uint8Array.from([1, 4, ...new TextEncoder().encode("a:bc"), 0xC0, 0xD1, 0, 0xD0])), /MEANING applied to a unit/)
    })

    test("negative min/max/default round-trip correctly (zigzag sign)", () =>
    {
        assert.equal(derefType(roundTrip(integer(-100, -1, {default: -50})).decoded).kind, SemanticTypeKinds.Integer)
        const d = derefType(roundTrip(integer(-100, -1, {default: -50})).decoded)
        assert.deepEqual(d, { kind: SemanticTypeKinds.Integer, min: -100, max: -1, default: -50 })
    })

    test("a range outside the signed 32-bit window throws rather than silently wrapping", () =>
    {
        assert.throws(() => encodeTypeTree(integer(0, 5_000_000_000)))
    })
})

describe("type tree wire — list", () =>
{
    test("an unbounded list from 0 costs one tag byte, no operand", () =>
    {
        const { bytes } = roundTrip(list(u8))
        assert.deepEqual([...bytes], [0, 0xC1, 0xCB, 0xD0])
    })

    test("each list bound form carries exactly its operands", () =>
    {
        assert.deepEqual([...roundTrip(list(u8, {maxLength: 16})).bytes], [0, 0xC1, 0xCC, 16, 0xD0])
        assert.deepEqual([...roundTrip(fixedBytes(6)).bytes], [0, 0xC1, 0xD2, 6, 0xD0])
        assert.deepEqual([...roundTrip(list(u8, {minLength: 2, maxLength: 9})).bytes], [0, 0xC1, 0xD3, 2, 9, 0xD0])
        assert.deepEqual([...roundTrip(list(u8, {minLength: 3})).bytes], [0, 0xC1, 0xD4, 3, 0xD0])
    })
})

describe("type tree wire — struct / union, compact form", () =>
{
    test("a small struct's tag byte literally is its field count", () =>
    {
        const bytes = encodeTypeTree(struct({ a: u8, b: unit }))
        // table(count=2,"a","b") | PUSH_U8, PUSH_UNIT | STRUCT tag=2 (the
        // field count itself, no separate operand) | name-spec: [0,1] is
        // one contiguous range, length=2 -> (length-2)<<1=0, base=0 | END
        assert.deepEqual([...bytes], [2, 1, 97, 1, 98, 0xC1, 0xC0, 2, 0, 0, 0xD0])
    })

    test("field declaration order survives the round trip", () =>
    {
        const { decoded } = roundTrip(struct({ a: u8, b: unit, c: i16 }))
        assert.deepEqual([...(derefType(decoded) as { fields: Map<string, SemanticType> }).fields.keys()], ["a", "b", "c"])
    })

    test("struct/union with >=64 members falls through to the _EXT form", () =>
    {
        const fields: Record<string, SemanticType> = {}
        for(let i = 0; i < 70; i++) fields[`f${i}`] = u8
        roundTrip(struct(fields))

        const variants: Record<string, SemanticType> = {}
        for(let i = 0; i < 70; i++) variants[`v${i}`] = unit
        roundTrip(union(variants))
    })

    test("union with a declared default variant round-trips it", () =>
    {
        const t = union({ temperature: i16, unrecognized: unit }, {defaultVariant: "unrecognized"})
        const { decoded } = roundTrip(t)
        assert.equal((derefType(decoded) as { defaultVariant?: string }).defaultVariant, "unrecognized")
    })

    test("union without a default variant round-trips as undefined, not a sentinel string", () =>
    {
        const { decoded } = roundTrip(union({ ok: unit, err: unit }))
        assert.equal((derefType(decoded) as { defaultVariant?: string }).defaultVariant, undefined)
    })
})

describe("type tree wire — name specification (§3.3 range list)", () =>
{
    test("fresh (never-seen) field names land in the string table as one contiguous run in the name-spec", () =>
    {
        const bytes = encodeTypeTree(struct({ alpha: u8, beta: i8, gamma: u16 }))

        const enc = new TextEncoder()
        const nameBytes = (s: string) => [s.length, ...enc.encode(s)]
        const table = [3, ...nameBytes("alpha"), ...nameBytes("beta"), ...nameBytes("gamma")]
        // children: PUSH_U8, PUSH_I8, PUSH_U16 | STRUCT tag=3 | name-spec:
        // indices [0,1,2] are contiguous -> ONE range, length=3 encodes as
        // (length-2)<<1=2, then base=0 -- two LEB128 bytes, not three
        // separate per-name indices.
        const instructions = [0xC1, 0xC2, 0xC3, 3, 2, 0, 0xD0]
        assert.deepEqual([...bytes], [...table, ...instructions])
    })

    test("a name reused across two structs still decodes correctly even though it breaks contiguity for the second", () =>
    {
        const shared = "value"
        const t = struct({
            first: struct({ [shared]: u8, other: i8 }),
            second: struct({ another: u16, [shared]: i16 }),
        })
        roundTrip(t)
    })
})

describe("type tree wire — PUSH_REF dedup", () =>
{
    test("two fields sharing the exact same type object dedup via PUSH_REF", () =>
    {
        const shared = struct({ secs: u32, nanos: u32 })
        const t = struct({ createdAt: shared, updatedAt: shared })
        const bytes = encodeTypeTree(t)
        // createdAt builds the real struct (children + tag + namespec);
        // updatedAt should cost just one compact PUSH_REF byte instead of
        // a second full copy — compare against a struct whose second
        // field is a genuinely different shape, so nothing dedups there.
        const noDedupPossible = encodeTypeTree(struct({
            createdAt: struct({ secs: u32, nanos: u32 }),
            updatedAt: struct({ secs: i16, nanos: i16 }),
        }))
        assert.ok(bytes.length < noDedupPossible.length)
        roundTrip(t)
    })

    test("two independently-written but structurally identical objects dedup too — identity is irrelevant", () =>
    {
        // NOT the same object — two separate struct({...}) calls, deliberately.
        const t = struct({ a: struct({ x: u8, y: u8 }), b: struct({ x: u8, y: u8 }) })
        const withDedup = encodeTypeTree(t)
        const distinctShape = encodeTypeTree(struct({ a: struct({ x: u8, y: u8 }), b: struct({ x: u16, y: u16 }) }))
        assert.ok(withDedup.length < distinctShape.length)
        roundTrip(t)
    })

    test("a dedup hit more than 64 constructions back falls through to PUSH_REF_EXT", () =>
    {
        const shared = u16
        const fields: Record<string, SemanticType> = { first: shared }
        // Pad with >64 fresh, distinct constructions between the two shared uses.
        for(let i = 0; i < 70; i++) fields[`pad${i}`] = integer(0, 100 + i)
        fields.second = shared
        roundTrip(struct(fields))
    })
})

describe("type tree wire — self-framing and errors", () =>
{
    test("END requires exactly one value left on the stack", () =>
    {
        // Hand-crafted: string table count=0, then END immediately — no
        // construction ever happened, so the stack is empty, not size 1.
        assert.throws(() => decodeTypeTree(Uint8Array.from([0, 0xD0])))
    })

    test("an unrecognized opcode byte throws", () =>
    {
        assert.throws(() => decodeTypeTree(Uint8Array.from([0, 0xFF])))
    })

    test("decode reports `next` immediately past END, for a container with more sections after it", () =>
    {
        const bytes = encodeTypeTree(u8)
        const withTrailingJunk = Uint8Array.from([...bytes, 1, 2, 3])
        const { next } = decodeTypeTree(withTrailingJunk)
        assert.equal(next, bytes.length)
    })
})

describe("type tree wire — a realistic schema", () =>
{
    // Mirrors ppl-example's schema.ts TelemetryPacket shape
    // (device id, timestamp struct, a capacitated list of readings whose
    // own type is a struct with a nested all-unit union, a status
    // bitfield) — the example is a separate consumer, not a dependency, so
    // the shape is reproduced here rather than imported.
    test("a TelemetryPacket-shaped schema round-trips exactly", () =>
    {
        const Timestamp = struct({ secs: integer(0, 0xFFFFFFFF), nanos: integer(0, 999_999_999) })
        const SensorKind = union({ temperature: unit, humidity: unit, pressure: unit })
        const SensorReading = struct({ sensor: SensorKind, value: integer(-32768, 32767), unit: integer(0, 255) })
        const TelemetryPacket = struct({
            deviceId: integer(0, 0xFFFFFFFF),
            timestamp: Timestamp,
            readings: list(SensorReading, {maxLength: 16}),
            status: integer(0, 0xFFFF),
        })
        roundTrip(TelemetryPacket)
    })
})
