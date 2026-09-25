/**
 * src/target-js/test — MAC frames through generated code (the workspace's
 * docs/crypto.md §6.4): the interpreter's bytes, a round trip, a
 * `CodecTrap` carrying the frame's code on any flipped bit or a different
 * key, and entry points that check the key table before running.
 */
import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import { struct, list, u8, u16, named, buildTypeGraph, matchType } from "../../src/core/index"
import { run } from "mog-core"
import type { CodecRule, FrameSpec } from "../../src/codecs/index"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, createCodecExtension, framedEncode, framedDecode } from "../../src/codecs/index"
import type { CodecTrap } from "../../src/target-js/runtime/codec-runtime"

import { generateCodecModule } from "../../src/target-js/engine/codec-module"
import { loadGenerated } from "./load-generated"

const Packet = named("Packet", struct({ id: u8, samples: list(u16) }))
const value = { id: 7, samples: [1, 0x1234, 0xffff] }
const TRAP_MAC = 0x53

const ruleFor = (rules: readonly CodecRule<void>[]): CodecRule<void> => rules.find(r => matchType(Packet, r.pattern) !== undefined)!

const programs = (spec: FrameSpec) => ({
    encodeProgram: buildCodec(Packet, [framedEncode(spec, ruleFor(binaryEncodeRules), "Packet"), ...binaryEncodeRules], undefined),
    decodeProgram: buildCodec(Packet, [framedDecode(spec, ruleFor(binaryDecodeRules), "Packet"), ...binaryDecodeRules], undefined),
})

const counting = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => from + i)
const isTrap = (e: unknown): boolean => e instanceof Error && e.name === "CodecTrap" && (e as CodecTrap).code === TRAP_MAC

describe("MAC frame — generated code", () =>
{
    const specs: FrameSpec[] = [
        { alg: "HMAC-SHA-256", params: { key: "uplink", tag_len: 16 }, code: TRAP_MAC },
        { alg: "KMAC128", params: { key: "telemetry", out_len: 24, customization: [0x70, 0x70, 0x6c] }, code: TRAP_MAC },
        { alg: "BLAKE2s", params: { key: "config" }, code: TRAP_MAC },
    ]

    for(const spec of specs)
    {
        const slot = spec.params!.key as string
        const keys = new Map([[slot, counting(32, 0x20)]])
        const otherKeys = new Map([[slot, counting(32, 0x21)]])

        test(`${spec.alg} ${JSON.stringify(spec.params)}: the interpreter's bytes, a round trip, and a trap on every flipped bit or another key`, () =>
        {
            const { encodeProgram, decodeProgram } = programs(spec)
            const mod = loadGenerated(generateCodecModule({ name: "Packet", rootType: Packet, encodeProgram, decodeProgram }))

            const interpreted: number[] = []
            const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: buildTypeGraph(Packet).root }, interpreted, keys)
            assert.equal(run(encodeProgram, ext).ok, true)

            const good: Uint8Array = mod.encodePacket(value, keys)
            assert.deepEqual(Array.from(good), interpreted)
            assert.deepEqual(mod.decodePacket(good, keys), value)
            assert.throws(() => mod.decodePacket(good, otherKeys), isTrap)

            for(let byte = 0; byte < good.length; byte++)
                for(let bit = 0; bit < 8; bit++)
                {
                    const bad = Uint8Array.from(good)
                    bad[byte]! ^= 1 << bit
                    assert.throws(() => mod.decodePacket(bad, keys), isTrap, `byte ${byte} bit ${bit}`)
                }
        })
    }

    test("both entry points reject a missing or wrong-length key before running", () =>
    {
        const mod = loadGenerated(generateCodecModule({ name: "Packet", rootType: Packet, ...programs(specs[2]!) }))
        const good: Uint8Array = mod.encodePacket(value, new Map([["config", counting(32)]]))
        for(const keys of [new Map(), new Map([["uplink", counting(32)]]), new Map([["config", counting(33)]])])
        {
            assert.throws(() => mod.encodePacket(value, keys), /key slot "config": BLAKE2s needs a key of 1\.\.32 bytes/)
            assert.throws(() => mod.decodePacket(good, keys), /key slot "config": BLAKE2s needs a key of 1\.\.32 bytes/)
        }
    })
})
