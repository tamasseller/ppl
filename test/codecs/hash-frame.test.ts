/**
 * src/codecs/test — Keyless hashes (engine/crypto/hashes.ts, the workspace's
 * docs/crypto.md §6.3): each standard's "abc" vector, the parameters, and
 * hash frames under the interpreter
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import { struct, list, u8, u16, named, buildTypeGraph, matchType } from "../../src/core/index"
import type { VmResult } from "mog-core"
import { validateProgram, run } from "mog-core"

import type { CodecRule } from "../../src/codecs/engine/resolver"
import { buildCodec } from "../../src/codecs/engine/resolver"
import { createCodecExtension } from "../../src/codecs/engine/codec-extension"
import { validateCodecHandles } from "../../src/codecs/engine/validate-handles"
import { binaryEncodeRules, binaryDecodeRules } from "../../src/codecs/components/binary-rules"
import type { FrameSpec } from "../../src/codecs/components/framed"
import { framedEncode, framedDecode } from "../../src/codecs/components/framed"
import type { CryptoParam } from "../../src/codecs/engine/crypto/crypto"
import { createCryptoContext, integerParamBytes } from "../../src/codecs/engine/crypto/crypto"
import { HASH_NAMES } from "../../src/codecs/engine/crypto/hashes"

const abc = [0x61, 0x62, 0x63]
const int = (name: string, v: number): CryptoParam => ({ name, value: integerParamBytes(v) })
const bytes = (name: string, v: readonly number[]): CryptoParam => ({ name, value: v })

function digest(alg: string, params: readonly CryptoParam[], data: readonly number[], chunks: readonly number[] = [data.length]): string
{
    const c = createCryptoContext(alg, params)
    let at = 0
    for(const n of chunks) { c.absorb(data, at, at + n); at += n }
    return Buffer.from(c.final()).toString("hex")
}

/** FIPS 180-4, FIPS 202, RFC 7693 Appendix A and RFC 1321/3174's "abc". */
const ABC: readonly (readonly [string, string, readonly CryptoParam[]])[] = [
    ["MD5", "900150983cd24fb0d6963f7d28e17f72", []],
    ["SHA-1", "a9993e364706816aba3e25717850c26c9cd0d89d", []],
    ["SHA-224", "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7", []],
    ["SHA-256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", []],
    ["SHA-384", "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7", []],
    ["SHA-512", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", []],
    ["SHA-512/224", "4634270f707b6a54daae7530460842e20e37ed265ceee9a43e8924aa", []],
    ["SHA-512/256", "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23", []],
    ["SHA3-224", "e642824c3f8cf24ad09234ee7d3c766fc9a3a5168d0c94ad73b46fdf", []],
    ["SHA3-256", "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532", []],
    ["SHA3-384", "ec01498288516fc926459f58e2c6ad8df9b473cb0fc08c2596da7cf0e49be4b298d88cea927ac7f539f1edf228376d25", []],
    ["SHA3-512", "b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0", []],
    ["SHAKE128", "5881092dd818bf5cf8a3ddb793fbcba74097d5c526a6d35f97b83351940f2cc8", [int("out_len", 32)]],
    ["SHAKE256", "483366601360a8771c6863080cc4114d8db44530f8f1e1ee4f94ea37e78b5739d5a15bef186a5386c75744c0527e1faa9f8726e462a12a4feb06bd8801e751e4", [int("out_len", 64)]],
    ["BLAKE2b", "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923", []],
    ["BLAKE2s", "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982", []],
]

describe("hashes — known answers", () =>
{
    test("every implemented name has its standard's \"abc\" vector here", () =>
    {
        assert.deepEqual(ABC.map(([alg]) => alg).sort(), [...HASH_NAMES].sort())
    })

    for(const [alg, hex, params] of ABC)
        test(`${alg}("abc")`, () => assert.equal(digest(alg, params, abc), hex))

    test("absorbing in chunks gives the one-shot digest", () =>
    {
        const data = Array.from({ length: 1000 }, (_, i) => (i * 131) & 0xff)
        for(const alg of ["SHA-256", "SHA3-512", "BLAKE2s"])
            assert.equal(digest(alg, [], data, [1, 63, 64, 0, 872]), digest(alg, [], data), alg)
    })

    test("a long SHAKE256 output agrees with node:crypto", () =>
    {
        const data = Array.from({ length: 300 }, (_, i) => i & 0xff)
        assert.equal(digest("SHAKE256", [int("out_len", 1000)], data),
            createHash("shake256", { outputLength: 1000 }).update(Buffer.from(data)).digest("hex"))
    })
})

describe("hashes — parameters", () =>
{
    test("tag_len truncates a fixed digest to its prefix", () =>
    {
        assert.equal(digest("SHA-256", [int("tag_len", 12)], abc), ABC.find(([a]) => a === "SHA-256")![1].slice(0, 24))
    })

    test("BLAKE2's out_len is its own digest, not a truncation", () =>
    {
        const full = digest("BLAKE2b", [], abc)
        const short = digest("BLAKE2b", [int("out_len", 20)], abc)
        assert.equal(short.length, 40)
        assert.notEqual(short, full.slice(0, 40))
    })

    test("salt and personal change a BLAKE2 digest", () =>
    {
        const plain = digest("BLAKE2s", [], abc)
        assert.notEqual(digest("BLAKE2s", [bytes("salt", [1, 2, 3, 4, 5, 6, 7, 8])], abc), plain)
        assert.notEqual(digest("BLAKE2s", [bytes("personal", [1, 2, 3, 4, 5, 6, 7, 8])], abc), plain)
    })

    test("a missing, unknown or out-of-range parameter is a hard error", () =>
    {
        assert.throws(() => createCryptoContext("SHAKE128", []), /SHAKE128: missing parameter "out_len"/)
        assert.throws(() => createCryptoContext("SHAKE128", [int("out_len", 0)]), /"out_len" must be 1\.\./)
        assert.throws(() => createCryptoContext("SHAKE128", [int("out_len", 32), int("tag_len", 16)]), /unknown parameter "tag_len"/)
        assert.throws(() => createCryptoContext("SHA-256", [int("out_len", 16)]), /unknown parameter "out_len"/)
        assert.throws(() => createCryptoContext("SHA-256", [int("tag_len", 33)]), /"tag_len" must be 1\.\.32/)
        assert.throws(() => createCryptoContext("BLAKE2b", [int("out_len", 65)]), /"out_len" must be 1\.\.64/)
        assert.throws(() => createCryptoContext("BLAKE2b", [bytes("key", [1])]), /unknown parameter "key"/)
        assert.throws(() => createCryptoContext("BLAKE2s", [bytes("salt", [1, 2, 3])]), /"salt" must be 8 bytes/)
        assert.throws(() => createCryptoContext("SHA-256", [int("tag_len", 8), int("tag_len", 8)]), /given twice/)
    })

    test("a name is compared exactly", () =>
    {
        for(const name of ["sha-256", "SHA256", "SHA-256 ", "Blake2b", "SHA3_256"])
            assert.throws(() => createCryptoContext(name, []), /unknown algorithm/, name)
    })
})

const Packet = named("Packet", struct({ id: u8, samples: list(u16) }))
const value = { id: 7, samples: [1, 0x1234, 0xffff] }
const TRAP_HASH = 0x52

const ruleFor = (rules: readonly CodecRule<void>[]): CodecRule<void> => rules.find(r => matchType(Packet, r.pattern) !== undefined)!

function encode(spec: FrameSpec | undefined, v: unknown): number[]
{
    const rules = spec ? [framedEncode(spec, ruleFor(binaryEncodeRules), "Packet"), ...binaryEncodeRules] : binaryEncodeRules
    const program = buildCodec(Packet, rules, undefined)
    const buffer: number[] = []
    const ext = createCodecExtension("encode", { container: { root: v }, key: "root", type: buildTypeGraph(Packet).root }, buffer)
    validateProgram(program, ext)
    validateCodecHandles(program)
    assert.equal(run(program, ext).ok, true)
    return buffer
}

function decode(spec: FrameSpec, wire: readonly number[]): { result: VmResult; value: unknown }
{
    const program = buildCodec(Packet, [framedDecode(spec, ruleFor(binaryDecodeRules), "Packet"), ...binaryDecodeRules], undefined)
    const wrapper: Record<string, unknown> = { root: {} }
    const ext = createCodecExtension("decode", { container: wrapper, key: "root", type: buildTypeGraph(Packet).root }, [...wire])
    validateProgram(program, ext)
    validateCodecHandles(program)
    return { result: run(program, ext), value: wrapper.root }
}

const paramsOf = (spec: FrameSpec): CryptoParam[] =>
    Object.entries(spec.params ?? {}).map(([name, v]) => typeof v === "number" ? int(name, v) : bytes(name, v))

describe("hash frame — under the interpreter", () =>
{
    const specs: readonly FrameSpec[] = [
        { alg: "SHA-256", code: TRAP_HASH },
        { alg: "SHA3-512", code: TRAP_HASH },
        { alg: "SHAKE128", params: { out_len: 12 }, code: TRAP_HASH },
        { alg: "SHA-256", params: { tag_len: 7 }, code: TRAP_HASH },
        { alg: "BLAKE2s", params: { out_len: 16, personal: [0x70, 0x70, 0x6c, 0x2d, 0x74, 0x65, 0x73, 0x74] }, code: TRAP_HASH },
    ]

    for(const spec of specs)
    {
        const label = `${spec.alg}${spec.params ? ` ${JSON.stringify(spec.params)}` : ""}`

        test(`${label}: the digest of the unframed bytes, then those bytes, and a round trip`, () =>
        {
            const body = encode(undefined, value)
            const wire = encode(spec, value)
            assert.deepEqual(wire, [...Buffer.from(digest(spec.alg, paramsOf(spec), body), "hex"), ...body])
            const { result, value: decoded } = decode(spec, wire)
            assert.equal(result.ok, true)
            assert.deepEqual(decoded, value)
        })

        test(`${label}: every single-bit flip traps with the frame's code`, () =>
        {
            const good = encode(spec, value)
            for(let byte = 0; byte < good.length; byte++)
                for(let bit = 0; bit < 8; bit++)
                {
                    const bad = [...good]
                    bad[byte]! ^= 1 << bit
                    assert.equal(decode(spec, bad).result.trapCode, TRAP_HASH, `byte ${byte} bit ${bit}`)
                }
        })
    }

    test("a hash the engine does not implement fails when the frame is built", () =>
    {
        assert.throws(() => framedEncode({ alg: "SHAKE128", code: TRAP_HASH }, ruleFor(binaryEncodeRules), "Packet"), /missing parameter "out_len"/)
    })
})
