/**
 * src/target-js/test — Hash frames through generated code (the workspace's
 * docs/crypto.md §6.3): the interpreter's bytes, a round trip, and a
 * `CodecTrap` carrying the frame's code on any flipped bit.
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
const TRAP_HASH = 0x52

const ruleFor = (rules: readonly CodecRule<void>[]): CodecRule<void> => rules.find(r => matchType(Packet, r.pattern) !== undefined)!

const programs = (spec: FrameSpec) => ({
    encodeProgram: buildCodec(Packet, [framedEncode(spec, ruleFor(binaryEncodeRules), "Packet"), ...binaryEncodeRules], undefined),
    decodeProgram: buildCodec(Packet, [framedDecode(spec, ruleFor(binaryDecodeRules), "Packet"), ...binaryDecodeRules], undefined),
})

describe("hash frame — generated code", () =>
{
    const specs: FrameSpec[] = [
        { alg: "SHA-256", code: TRAP_HASH },
        { alg: "SHAKE256", params: { out_len: 40 }, code: TRAP_HASH },
        { alg: "BLAKE2b", params: { out_len: 24, salt: Array.from({ length: 16 }, (_, i) => i) }, code: TRAP_HASH },
    ]

    for(const spec of specs)
    {
        test(`${spec.alg}${spec.params ? ` ${JSON.stringify(spec.params)}` : ""}: the interpreter's bytes, a round trip, and a trap on every flipped bit`, () =>
        {
            const { encodeProgram, decodeProgram } = programs(spec)
            const mod = loadGenerated(generateCodecModule({ name: "Packet", rootType: Packet, encodeProgram, decodeProgram }))

            const interpreted: number[] = []
            const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: buildTypeGraph(Packet).root }, interpreted)
            assert.equal(run(encodeProgram, ext).ok, true)

            const good: Uint8Array = mod.encodePacket(value)
            assert.deepEqual(Array.from(good), interpreted)
            assert.deepEqual(mod.decodePacket(good), value)

            for(let byte = 0; byte < good.length; byte++)
                for(let bit = 0; bit < 8; bit++)
                {
                    const bad = Uint8Array.from(good)
                    bad[byte]! ^= 1 << bit
                    assert.throws(() => mod.decodePacket(bad),
                        (e: unknown) => e instanceof Error && e.name === "CodecTrap" && (e as CodecTrap).code === TRAP_HASH, `byte ${byte} bit ${bit}`)
                }
        })
    }
})
