/**
 * src/target-js/test — CRC frames through generated code (the workspace's
 * docs/crypto.md §6.2): the same bytes as the interpreter, the same
 * round trip, and a `CodecTrap` carrying the frame's code on a mismatch.
 */
import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import type { SemanticType } from "../../src/core/index"
import { struct, union, unit, list, u8, u16, named, buildTypeGraph, matchType } from "../../src/core/index"
import { run } from "mog-core"
import type { CodecRule, FrameSpec } from "../../src/codecs/index"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, createCodecExtension, framedEncode, framedDecode } from "../../src/codecs/index"
import { CodecTrap } from "../../src/target-js/runtime/codec-runtime"

import { generateCodecModule } from "../../src/target-js/engine/codec-module"
import { loadGenerated } from "./load-generated"

const Packet = named("Packet", struct({
    id: u8,
    samples: list(u16),
    mode: union({ idle: unit, level: u8 }),
}))

const value = { id: 7, samples: [1, 0x1234, 0xffff], mode: { variant: "level", value: 3 } }

const TRAP_CRC = 0x51

const ruleFor = (type: SemanticType, rules: readonly CodecRule<void>[]): CodecRule<void> =>
    rules.find(r => matchType(type, r.pattern) !== undefined)!

const programs = (spec: FrameSpec) => ({
    encodeProgram: buildCodec(Packet, [framedEncode(spec, ruleFor(Packet, binaryEncodeRules), "Packet"), ...binaryEncodeRules], undefined),
    decodeProgram: buildCodec(Packet, [framedDecode(spec, ruleFor(Packet, binaryDecodeRules), "Packet"), ...binaryDecodeRules], undefined),
})

function compiled(spec: FrameSpec): { encode: (v: unknown) => Uint8Array; decode: (b: Uint8Array) => unknown }
{
    const mod = loadGenerated(generateCodecModule({ name: "Packet", rootType: Packet, ...programs(spec) }))
    return { encode: mod.encodePacket, decode: mod.decodePacket }
}

function interpretedEncode(spec: FrameSpec, v: unknown): number[]
{
    const buffer: number[] = []
    const ext = createCodecExtension("encode", { container: { root: v }, key: "root", type: buildTypeGraph(Packet).root }, buffer)
    assert.equal(run(programs(spec).encodeProgram, ext).ok, true)
    return buffer
}

describe("crc frame — generated code", () =>
{
    const specs: FrameSpec[] = [
        { alg: "CRC-16/IBM-3740", code: TRAP_CRC },
        { alg: "CRC-32/ISO-HDLC", params: { byteorder: 1 }, code: TRAP_CRC },
        { alg: "CRC-64/XZ", code: TRAP_CRC },
        { alg: "CRC", params: { width: 12, poly: 0x80f, init: 0, refin: 0, refout: 1, xorout: 0 }, code: TRAP_CRC },
    ]
    for(const spec of specs)
    {
        test(`${spec.alg}${spec.params ? ` ${JSON.stringify(spec.params)}` : ""}: same bytes as the interpreter, and round-trips`, () =>
        {
            const { encode, decode } = compiled(spec)
            const bytes = encode(value)
            assert.deepEqual(Array.from(bytes), interpretedEncode(spec, value))
            assert.deepEqual(decode(bytes), value)
        })
    }

    test("every single-bit flip throws a CodecTrap with the frame's code, before the body is read", () =>
    {
        const { encode, decode } = compiled({ alg: "CRC-16/IBM-3740", code: TRAP_CRC })
        const good = encode(value)
        for(let byte = 0; byte < good.length; byte++)
            for(let bit = 0; bit < 8; bit++)
            {
                const bad = Uint8Array.from(good)
                bad[byte]! ^= 1 << bit
                assert.throws(() => decode(bad), (e: unknown) => e instanceof Error && e.name === "CodecTrap" && (e as CodecTrap).code === TRAP_CRC,
                    `byte ${byte} bit ${bit}`)
            }
    })

    test("a truncated stream traps too, even one shorter than the CRC", () =>
    {
        const { encode, decode } = compiled({ alg: "CRC-16/IBM-3740", code: TRAP_CRC })
        const good = encode(value)
        for(const cut of [good.length - 1, 1, 0])
            assert.throws(() => decode(good.subarray(0, cut)), (e: unknown) => (e as CodecTrap).code === TRAP_CRC, `cut ${cut}`)
    })

    test("an algorithm the runtime does not implement fails at generation", () =>
    {
        assert.throws(() => generateCodecModule({ name: "Packet", rootType: Packet, ...programs({ alg: "SHAKE256", code: TRAP_CRC }) }),
            /unknown algorithm "SHAKE256"/)
    })
})
