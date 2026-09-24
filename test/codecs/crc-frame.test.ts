/**
 * src/codecs/test — CRC frames (components/framed.ts, the workspace's
 * docs/crypto.md §6.2), under the interpreter
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { SemanticType } from "../../src/core/index"
import { struct, union, unit, list, u8, u16, named, buildTypeGraph, matchType, kindOf, SemanticTypeKinds } from "../../src/core/index"
import type { VmResult } from "mog-core"
import { validateProgram, run, ir, proc, lowerProgram } from "mog-core"

import type { CodecRule } from "../../src/codecs/engine/resolver"
import { buildCodec } from "../../src/codecs/engine/resolver"
import { createCodecExtension, codecRules } from "../../src/codecs/engine/codec-extension"
import { initInstr } from "../../src/codecs/engine/codec-ext-instr"
import { validateCodecHandles } from "../../src/codecs/engine/validate-handles"
import { binaryEncodeRules, binaryDecodeRules } from "../../src/codecs/components/binary-rules"
import type { FrameSpec } from "../../src/codecs/components/framed"
import { framedEncode, framedDecode } from "../../src/codecs/components/framed"
import { CRC_CATALOGUE } from "../../src/codecs/engine/crc-catalogue"
import { createCryptoContext, crcValue, integerParamBytes } from "../../src/codecs/engine/crypto"

const Packet = named("Packet", struct({
    id: u8,
    samples: list(u16),
    mode: union({ idle: unit, level: u8 }),
}))

const value = { id: 7, samples: [1, 0x1234, 0xffff], mode: { variant: "level", value: 3 } }

const TRAP_CRC = 0x51

const ruleFor = (type: SemanticType, rules: readonly CodecRule<void>[]): CodecRule<void> =>
    rules.find(r => matchType(type, r.pattern) !== undefined)!

const encodeRules = (spec: FrameSpec): CodecRule<void>[] =>
    [framedEncode(spec, ruleFor(Packet, binaryEncodeRules), "Packet"), ...binaryEncodeRules]

const decodeRules = (spec: FrameSpec): CodecRule<void>[] =>
    [framedDecode(spec, ruleFor(Packet, binaryDecodeRules), "Packet"), ...binaryDecodeRules]

function encode(type: SemanticType, rules: readonly CodecRule<void>[], v: unknown): number[]
{
    const program = buildCodec(type, rules, undefined)
    const buffer: number[] = []
    const ext = createCodecExtension("encode", { container: { root: v }, key: "root", type: buildTypeGraph(type).root }, buffer)
    validateProgram(program, ext)
    validateCodecHandles(program)
    const result = run(program, ext)
    assert.equal(result.ok, true, `encode trapped (code ${result.trapCode})`)
    return buffer
}

function decode(type: SemanticType, rules: readonly CodecRule<void>[], bytes: readonly number[]): { result: VmResult; value: unknown }
{
    const program = buildCodec(type, rules, undefined)
    const graph = buildTypeGraph(type)
    const wrapper: Record<string, unknown> = { root: kindOf(graph.root.type) === SemanticTypeKinds.Struct ? {} : undefined }
    const ext = createCodecExtension("decode", { container: wrapper, key: "root", type: graph.root }, [...bytes])
    validateProgram(program, ext)
    validateCodecHandles(program)
    return { result: run(program, ext), value: wrapper.root }
}

const crcBytes = (alg: string, body: readonly number[], bigEndian: boolean, width: number): number[] =>
{
    let v = crcValue(alg, [], body)
    const le: number[] = []
    for(let i = 0; i < Math.ceil(width / 8); i++, v >>= 8n) le.push(Number(v & 0xffn))
    return bigEndian ? le.reverse() : le
}

describe("crc frame — round trip", () =>
{
    for(const alg of ["CRC-16/IBM-3740", "CRC-32/ISO-HDLC", "CRC-8/SMBUS", "CRC-64/XZ", "CRC-5/USB"])
    {
        test(`${alg}: a framed struct decodes to the tree it was encoded from`, () =>
        {
            const spec = { alg, code: TRAP_CRC }
            const { result, value: decoded } = decode(Packet, decodeRules(spec), encode(Packet, encodeRules(spec), value))
            assert.equal(result.ok, true)
            assert.deepEqual(decoded, value)
        })
    }

    test("a variable-length delegated body round-trips at every length, so ABSORB catches up without a count", () =>
    {
        const spec = { alg: "CRC-32/ISO-HDLC", code: TRAP_CRC }
        for(const n of [0, 1, 2, 17, 200])
        {
            const v = { ...value, samples: Array.from({ length: n }, (_, i) => (i * 257) & 0xffff) }
            const { result, value: decoded } = decode(Packet, decodeRules(spec), encode(Packet, encodeRules(spec), v))
            assert.equal(result.ok, true, `n=${n}`)
            assert.deepEqual(decoded, v, `n=${n}`)
        }
    })

    test("a frame as the stream's last field leaves what precedes it unframed", () =>
    {
        const Outer = struct({ head: u8, packet: Packet })
        const spec = { alg: "CRC-8/SMBUS", code: TRAP_CRC }
        const v = { head: 1, packet: value }
        const bytes = encode(Outer, encodeRules(spec), v)
        const body = encode(Packet, binaryEncodeRules, value)
        assert.deepEqual(bytes, [1, ...crcBytes("CRC-8/SMBUS", body, true, 8), ...body])
        const { result, value: decoded } = decode(Outer, decodeRules(spec), bytes)
        assert.equal(result.ok, true)
        assert.deepEqual(decoded, v)
    })

    test("a frame followed by more of the stream traps: its CRC covers the rest of the stream", () =>
    {
        const Outer = struct({ packet: Packet, tail: u8 })
        const spec = { alg: "CRC-8/SMBUS", code: TRAP_CRC }
        const bytes = encode(Outer, encodeRules(spec), { packet: value, tail: 2 })
        assert.equal(decode(Outer, decodeRules(spec), bytes).result.trapCode, TRAP_CRC)
    })
})

describe("crc frame — wire bytes", () =>
{
    const body = encode(Packet, binaryEncodeRules, value)

    test("the CRC, big-endian by default for an unreflected CRC, then the unframed bytes", () =>
    {
        assert.deepEqual(encode(Packet, encodeRules({ alg: "CRC-16/IBM-3740", code: TRAP_CRC }), value),
            [...crcBytes("CRC-16/IBM-3740", body, true, 16), ...body])
    })

    test("little-endian by default for a reflected CRC", () =>
    {
        assert.deepEqual(encode(Packet, encodeRules({ alg: "CRC-32/ISO-HDLC", code: TRAP_CRC }), value),
            [...crcBytes("CRC-32/ISO-HDLC", body, false, 32), ...body])
    })

    for(const [byteorder, bigEndian] of [[0, false], [1, true]] as const)
    {
        test(`byteorder ${byteorder} overrides the default, and decode agrees`, () =>
        {
            for(const alg of ["CRC-16/IBM-3740", "CRC-32/ISO-HDLC"])
            {
                const spec = { alg, params: { byteorder }, code: TRAP_CRC }
                const bytes = encode(Packet, encodeRules(spec), value)
                const width = alg === "CRC-32/ISO-HDLC" ? 32 : 16
                assert.deepEqual(bytes, [...crcBytes(alg, body, bigEndian, width), ...body], alg)
                assert.equal(decode(Packet, decodeRules(spec), bytes).result.ok, true, alg)
            }
        })
    }

    test("a CRC narrower than a byte takes one byte", () =>
    {
        const bytes = encode(Packet, encodeRules({ alg: "CRC-5/USB", code: TRAP_CRC }), value)
        assert.equal(bytes.length, body.length + 1)
        assert.deepEqual(bytes.slice(0, 1), crcBytes("CRC-5/USB", body, false, 5))
    })

    test("the custom \"CRC\" spelling writes the same bytes as its catalogue name", () =>
    {
        const custom = { alg: "CRC", params: { width: 16, poly: 0x1021, init: 0xffff, refin: 0, refout: 0, xorout: 0 }, code: TRAP_CRC }
        assert.deepEqual(encode(Packet, encodeRules(custom), value), encode(Packet, encodeRules({ alg: "CRC-16/IBM-3740", code: TRAP_CRC }), value))
    })
})

describe("crc frame — a corrupted frame traps, and nothing else differs", () =>
{
    const spec = { alg: "CRC-16/IBM-3740", code: TRAP_CRC }
    const good = encode(Packet, encodeRules(spec), value)

    test("the happy path decodes exactly what the unframed codec does", () =>
    {
        const unframed = decode(Packet, binaryDecodeRules, good.slice(2))
        assert.deepEqual(decode(Packet, decodeRules(spec), good).value, unframed.value)
    })

    test("every single-bit flip, in body or CRC, traps with the frame's code", () =>
    {
        for(let byte = 0; byte < good.length; byte++)
            for(let bit = 0; bit < 8; bit++)
            {
                const bad = [...good]
                bad[byte]! ^= 1 << bit
                const { result } = decode(Packet, decodeRules(spec), bad)
                assert.equal(result.ok, false, `byte ${byte} bit ${bit}`)
                assert.equal(result.trapCode, TRAP_CRC, `byte ${byte} bit ${bit}`)
            }
    })

    test("a truncated or extended stream traps too", () =>
    {
        assert.equal(decode(Packet, decodeRules(spec), good.slice(0, -1)).result.trapCode, TRAP_CRC)
        assert.equal(decode(Packet, decodeRules(spec), good.slice(0, 1)).result.trapCode, TRAP_CRC)
        assert.equal(decode(Packet, decodeRules(spec), [...good, 0]).result.trapCode, TRAP_CRC)
    })
})

describe("crc engine — the RevEng catalogue", () =>
{
    const check = [..."123456789"].map(c => c.charCodeAt(0))

    test(`all ${CRC_CATALOGUE.length} entries yield their check value over "123456789"`, () =>
    {
        for(const e of CRC_CATALOGUE)
            assert.equal(crcValue(e.name, [], check), e.check, e.name)
    })

    test("each entry at most 32 bits wide yields it under the \"CRC\" spelling too", () =>
    {
        for(const e of CRC_CATALOGUE.filter(e => e.width <= 32))
        {
            const params = [
                { name: "width", value: integerParamBytes(e.width) },
                { name: "poly", value: integerParamBytes(e.poly) },
                { name: "init", value: integerParamBytes(e.init) },
                { name: "refin", value: integerParamBytes(e.refin ? 1 : 0) },
                { name: "refout", value: integerParamBytes(e.refout ? 1 : 0) },
                { name: "xorout", value: integerParamBytes(e.xorout) },
            ]
            assert.equal(crcValue("CRC", params, check), e.check, e.name)
        }
    })

    test("an alias is rejected, naming its canonical entry", () =>
    {
        assert.throws(() => createCryptoContext("CRC-16/CCITT-FALSE", []), /alias; name it by its catalogue entry, "CRC-16\/IBM-3740"/)
        assert.throws(() => createCryptoContext("PKZIP", []), /"CRC-32\/ISO-HDLC"/)
    })

    test("a name is compared exactly, never normalized", () =>
    {
        assert.throws(() => createCryptoContext("crc-32/iso-hdlc", []), /unknown algorithm/)
        assert.throws(() => createCryptoContext("CRC-32/ISO-HDLC ", []), /unknown algorithm/)
    })

    test("an unknown, missing or out-of-range parameter is a hard error", () =>
    {
        const p = (name: string, v: number) => ({ name, value: integerParamBytes(v) })
        assert.throws(() => createCryptoContext("CRC-32/ISO-HDLC", [p("tag_len", 4)]), /unknown parameter "tag_len"/)
        assert.throws(() => createCryptoContext("CRC-32/ISO-HDLC", [p("width", 32)]), /unknown parameter "width"/)
        assert.throws(() => createCryptoContext("CRC", [p("width", 8)]), /missing parameter "poly"/)
        assert.throws(() => createCryptoContext("CRC", ["width", "poly", "init", "refin", "refout", "xorout"].map(n => p(n, n === "width" ? 8 : n === "poly" ? 0x107 : 0))), /"poly" does not fit in 8 bits/)
        assert.throws(() => createCryptoContext("CRC-32/ISO-HDLC", [p("byteorder", 2)]), /must be 0 or 1/)
    })
})

describe("crypto_init in ir text", () =>
{
    const lower = (body: ReturnType<typeof ir>) => lowerProgram(proc([], body), { rules: codecRules })
    const initOf = (body: ReturnType<typeof ir>) => lower(body).procedures[0]!.body.find(i => i.op === "EXT")

    test("lowers to INIT with each parameter as its little-endian bytes", () =>
    {
        assert.deepEqual(initOf(ir`crypto_init(1, "CRC", "width", 16, "poly", 0x1021, "init", 0xffff, "refin", 0, "refout", 0, "xorout", 0, "iv", x"0a0b"); return;`),
            initInstr(1, "CRC", [
                { name: "width", value: [16] }, { name: "poly", value: [0x21, 0x10] }, { name: "init", value: [0xff, 0xff] },
                { name: "refin", value: [] }, { name: "refout", value: [] }, { name: "xorout", value: [] }, { name: "iv", value: [0x0a, 0x0b] },
            ]))
    })

    test("a malformed parameter list fails at lowering", () =>
    {
        assert.throws(() => lower(ir`crypto_init(0, "CRC", "width"); return;`), /name\/value pairs/)
        assert.throws(() => lower(ir`crypto_init(0, "CRC", 8, 8); return;`), /no string name/)
        assert.throws(() => lower(ir`crypto_init(0, "CRC", "width", "8"); return;`), /is a string/)
        assert.throws(() => lower(ir`crypto_init(0, "CRC", "width", 8, "width", 8); return;`), /"width" given twice/)
    })

    test("an unknown algorithm lowers, and fails when its INIT runs", () =>
    {
        const program = lower(ir`crypto_init(0, "SHAKE256"); return;`)
        const ext = createCodecExtension("encode", { container: { root: 0 }, key: "root", type: buildTypeGraph(u8).root }, [])
        assert.throws(() => run(program, ext), /unknown algorithm "SHAKE256"/)
    })
})
