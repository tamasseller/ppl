/**
 * src/codecs/test — Wire-level encoding for the codec extension's opcodes
 * (engine/wire.ts, docs/codec-extension.md §6)
 *
 * Mirrors `mog-core/test/bytecode.test.ts`'s own two-pronged approach:
 * a literal table of representative bytes (one row per band variant —
 * compact and extended, at each variant's own boundary), plus an
 * end-to-end round trip through a real, lowered codec program's
 * `encodeBody`/`decodeBody`.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { encodeInstr, decodeInstr, encodeBody, decodeBody, ir, lowerProgram, proc } from "mog-core"
import { callCodecInstr, callCodecNextInstr, cloneRdInstr, cloneWrInstr, countInstr, enterInstr, enterNextInstr, hasNextInstr, loadValInstr, openListInstr, readInstr, readSeqInstr, seekInstr, storeValInstr, tagInstr, writeInstr, writeSeqInstr, initInstr, absorbInstr, finalInstr, verifyInstr } from "../../src/codecs/engine/codec-ext-instr"
import type { CodecExtInstr } from "../../src/codecs/engine/codec-ext-instr"
import type { ExtInstrOf, Extension } from "mog-core"
import { struct, union, unit, u8, list } from "../../src/core/index"

import { codecWireCodec } from "../../src/codecs/engine/wire"
import { buildCodec } from "../../src/codecs/engine/resolver"
import { binaryEncodeRules } from "../../src/codecs/components/binary-rules"
import { codecRules } from "../../src/codecs/engine/codec-extension"

const ext: Extension<CodecExtInstr> = { codec: codecWireCodec }

interface Row { byte: number; instr: ExtInstrOf<CodecExtInstr> }

const rows: Row[] = [
    // ENTER dst, src, ref — compact: src*4+ref, base 128
    { byte: 128, instr: enterInstr(1, 0, 0) },       // src=0 ref=0 dst=1
    { byte: 143, instr: enterInstr(4, 3, 3) },       // src=3 ref=3 dst=4
    { byte: 144, instr: enterInstr(5, 0, 0) },       // dst != src+1 -> extended
    { byte: 144, instr: enterInstr(5, 4, 0) },       // src >= SMALL -> extended

    // ENTER_NEXT dst, src — base 145
    { byte: 145, instr: enterNextInstr(1, 0) },
    { byte: 148, instr: enterNextInstr(4, 3) },
    { byte: 149, instr: enterNextInstr(5, 0) },     // dst != src+1

    // LOAD_VAL src — base 150
    { byte: 150, instr: loadValInstr(0) },
    { byte: 153, instr: loadValInstr(3) },
    { byte: 154, instr: loadValInstr(4) },

    // STORE_VAL src — base 155
    { byte: 155, instr: storeValInstr(0) },
    { byte: 159, instr: storeValInstr(4) },

    // COUNT src — base 160
    { byte: 160, instr: countInstr(0) },
    { byte: 164, instr: countInstr(4) },

    // TAG src — base 165
    { byte: 165, instr: tagInstr(0) },
    { byte: 169, instr: tagInstr(4) },

    // OPEN_LIST src — base 170
    { byte: 170, instr: openListInstr(0) },
    { byte: 174, instr: openListInstr(4) },

    // READ iter, width — base 175, compact = iter*3+widthIdx
    { byte: 175, instr: readInstr(0, 1) },
    { byte: 186, instr: readInstr(3, 4) },
    { byte: 187, instr: readInstr(4, 1) },
    { byte: 189, instr: readInstr(4, 4) },

    // WRITE iter, width — base 190
    { byte: 190, instr: writeInstr(0, 1) },
    { byte: 201, instr: writeInstr(3, 4) },
    { byte: 202, instr: writeInstr(4, 1) },
    { byte: 204, instr: writeInstr(4, 4) },

    // HAS_NEXT iter — base 205
    { byte: 205, instr: hasNextInstr(0) },
    { byte: 209, instr: hasNextInstr(4) },

    // CLONE_RD src, dst — base 210
    { byte: 210, instr: cloneRdInstr(0, 1) },
    { byte: 213, instr: cloneRdInstr(3, 4) },
    { byte: 214, instr: cloneRdInstr(0, 5) },       // dst != src+1

    // CLONE_WR src, dst — base 215
    { byte: 215, instr: cloneWrInstr(0, 1) },
    { byte: 219, instr: cloneWrInstr(0, 5) },

    // SEEK iter, delta — one code, 220; iter and delta always LEB128'd
    { byte: 220, instr: seekInstr(0, 5) },
    { byte: 220, instr: seekInstr(3, -1) },
    { byte: 220, instr: seekInstr(4, 0) },

    // ESCAPE sub-code — 221, then 222..224 spare
    { byte: 221, instr: initInstr(0, "CRC-32/ISO-HDLC", []) },
    { byte: 221, instr: absorbInstr(0, 1, 0) },
    { byte: 221, instr: finalInstr(0, 0) },
    { byte: 221, instr: verifyInstr(0, 0, 7) },

    // CALL_CODEC codec_idx, src, ref — base 225, compact = src*4+ref
    { byte: 225, instr: callCodecInstr(7, 0, 0) },
    { byte: 240, instr: callCodecInstr(0, 3, 3) },
    { byte: 241, instr: callCodecInstr(7, 4, 0) },

    // CALL_CODEC_NEXT codec_idx, src — base 242
    { byte: 242, instr: callCodecNextInstr(9, 0) },
    { byte: 245, instr: callCodecNextInstr(9, 3) },
    { byte: 246, instr: callCodecNextInstr(9, 4) },

    // WRITE_SEQ iter, handle, width — base 247, one code per width
    // (codec-extension.md §3.5): iter/handle always LEB128'd, never a compact
    // index form (this file's own header explains why). No `count`
    // operand — it's a trailing pRtl("acc") DSL demand, read from `acc`
    // at runtime, never part of the instruction itself.
    { byte: 247, instr: writeSeqInstr(0, 1, 1) },
    { byte: 248, instr: writeSeqInstr(0, 1, 2) },
    { byte: 249, instr: writeSeqInstr(0, 1, 4) },

    // READ_SEQ iter, handle, width, signed — base 250, one code per
    // (width, signed) pair. Same no-`count`-operand reasoning as WRITE_SEQ.
    { byte: 250, instr: readSeqInstr(0, 1, 1, 0) },
    { byte: 251, instr: readSeqInstr(0, 1, 1, 1) },
    { byte: 252, instr: readSeqInstr(0, 1, 2, 0) },
    { byte: 253, instr: readSeqInstr(0, 1, 2, 1) },
    { byte: 254, instr: readSeqInstr(0, 1, 4, 0) },
    { byte: 255, instr: readSeqInstr(0, 1, 4, 1) },
]

describe("wire.ts — representative byte table", () =>
{
    test("every row's first encoded byte matches its assigned opcode", () =>
    {
        for (const { byte, instr } of rows)
        {
            const encoded = encodeInstr(instr, ext)
            assert.equal(encoded[0], byte,
                `${JSON.stringify(instr)}: expected first byte ${byte}, got ${encoded[0]}`)
        }
    })

    test("every row round-trips through decode", () =>
    {
        for (const { byte, instr } of rows)
        {
            const encoded = encodeInstr(instr, ext)
            const { instr: decoded, next } = decodeInstr(Uint8Array.from(encoded), 0, ext)
            assert.deepEqual(decoded, instr, `byte ${byte}: decode(encode(x)) !== x`)
            assert.equal(next, encoded.length, `byte ${byte}: decode didn't consume the whole instruction`)
        }
    })
})

describe("wire.ts — opcode-space budget", () =>
{
    test("every code but the three spare after ESCAPE decodes", () =>
    {
        for (let b = 128; b <= 255; b++)
        {
            if (b >= 222 && b <= 224)
                assert.throws(() => decodeInstr(Uint8Array.of(b, 0, 0, 0, 0, 0), 0, ext), /reserved and unassigned/, `byte ${b} is spare`)
            else
                assert.doesNotThrow(() => decodeInstr(Uint8Array.of(b, 0, 0, 0, 0, 0), 0, ext), `byte ${b} should decode`)
        }
    })
})

describe("wire.ts — escaped ops", () =>
{
    test("INIT carries its name length-prefixed and its parameters as a NUL-terminated TLV list", () =>
    {
        const instr = initInstr(2, "CRC", [{ name: "width", value: [16] }, { name: "iv", value: [] }])
        assert.deepEqual(encodeInstr(instr, ext), [
            221, 0, 2,
            3, 0x43, 0x52, 0x43,
            0x77, 0x69, 0x64, 0x74, 0x68, 0, 1, 16,
            0x69, 0x76, 0, 0,
            0,
        ])
    })

    test("the other three are sub-code, handle, then their iterators and code", () =>
    {
        assert.deepEqual(encodeInstr(absorbInstr(1, 2, 0), ext), [221, 1, 1, 2, 0])
        assert.deepEqual(encodeInstr(finalInstr(1, 0), ext), [221, 2, 1, 0])
        assert.deepEqual(encodeInstr(verifyInstr(1, 0, 300), ext), [221, 3, 1, 0, 0xac, 0x02])
    })

    test("every escaped op round-trips, a multi-byte UTF-8 name and wide parameter included", () =>
    {
        for (const instr of [
            initInstr(0, "CRC-82/DARC", [{ name: "byteorder", value: [1] }]),
            initInstr(300, "ünïcode", [{ name: "poly", value: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }]),
            absorbInstr(5, 200, 0), finalInstr(0, 3), verifyInstr(9, 1, 0xffff),
        ])
        {
            const encoded = encodeInstr(instr, ext)
            const { instr: decoded, next } = decodeInstr(Uint8Array.from(encoded), 0, ext)
            assert.deepEqual(decoded, instr)
            assert.equal(next, encoded.length)
        }
    })

    test("an unassigned sub-code is rejected, since its length is unknown", () =>
    {
        assert.throws(() => decodeInstr(Uint8Array.of(221, 4, 0, 0), 0, ext), /sub-code 4 is unassigned/)
    })

    test("a repeated parameter name is rejected both ways", () =>
    {
        const twice = [{ name: "a", value: [1] }, { name: "a", value: [2] }]
        assert.throws(() => encodeInstr(initInstr(0, "CRC", twice), ext), /given twice/)
        assert.throws(() => decodeInstr(Uint8Array.of(221, 0, 0, 0, 0x61, 0, 1, 1, 0x61, 0, 1, 2, 0), 0, ext), /given twice/)
    })

    test("a parameter name that is empty or contains NUL cannot be encoded", () =>
    {
        assert.throws(() => encodeInstr(initInstr(0, "CRC", [{ name: "", value: [] }]), ext), /empty or contains NUL/)
        assert.throws(() => encodeInstr(initInstr(0, "CRC", [{ name: "a\0b", value: [] }]), ext), /empty or contains NUL/)
    })

    test("a truncated INIT is rejected", () =>
    {
        const encoded = encodeInstr(initInstr(0, "CRC-32/ISO-HDLC", []), ext)
        assert.throws(() => decodeInstr(Uint8Array.from(encoded.slice(0, 6)), 0, ext))
        assert.throws(() => decodeInstr(Uint8Array.from(encoded.slice(0, -1)), 0, ext), /unterminated/)
    })
})

describe("wire.ts — SEEK's signed delta", () =>
{
    test("round-trips across zero, small positive, and small negative", () =>
    {
        for (const delta of [0, 1, -1, 127, -127, 1000, -1000])
        {
            const encoded = encodeInstr(seekInstr(0, delta), ext)
            const { instr } = decodeInstr(Uint8Array.from(encoded), 0, ext)
            assert.deepEqual(instr, seekInstr(0, delta), `delta=${delta}`)
        }
    })

    test("a negative delta stays negative all the way from the DSL to the wire and back", () =>
    {
        // The delta is an extension operand, not a core immediate: nothing
        // between `ir` and `encodeSigned` may coerce it to a machine word.
        const program = lowerProgram(proc([], ir`clone_rd(0, 1); seek(1, -2); return;`), { rules: codecRules })
        const lowered = program.procedures[0]!.body.find(i => i.op === "EXT" && (i as ExtInstrOf<CodecExtInstr>).ext === "SEEK")
        assert.deepEqual(lowered, seekInstr(1, -2))

        const { instr } = decodeInstr(Uint8Array.from(encodeInstr(lowered!, ext)), 0, ext)
        assert.deepEqual(instr, seekInstr(1, -2))
    })
})

describe("wire.ts — end-to-end: a real lowered codec program round-trips", () =>
{
    test("struct + list + union body encodes and decodes back to the same instructions", () =>
    {
        // Exercises ENTER (hoisted union tag gather), TAG, CALL_CODEC (per
        // field), CALL_CODEC_NEXT (list elements), WRITE/LOAD_VAL (the
        // shared integer leaf codec) — everything binary-rules.ts's default
        // encode path actually emits.
        const flag = union({ on: unit, off: unit })
        const elem = struct({ flag, value: u8 })
        const root = struct({ id: u8, items: list(elem) })

        const program = buildCodec(root, binaryEncodeRules, undefined)
        // Confirm this program actually reaches every opcode family this
        // test exists to cover — a program that happened to skip one would
        // make the round-trip below vacuously pass for it.
        const allOps = new Set(program.procedures.flatMap(p => p.body.filter(i => i.op === "EXT").map(i => (i as ExtInstrOf<CodecExtInstr>).ext)))
        for (const op of ["ENTER", "TAG", "CALL_CODEC", "CALL_CODEC_NEXT", "WRITE", "LOAD_VAL"] as const)
            assert.ok(allOps.has(op), `expected the test schema to exercise ${op}`)

        for (const proc of program.procedures)
        {
            const bytes = encodeBody(proc.body, ext)
            const decoded = decodeBody(bytes, ext)
            assert.deepEqual(decoded, proc.body)
        }
    })
})
