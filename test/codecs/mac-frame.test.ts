/**
 * src/codecs/test — MACs (engine/crypto/macs.ts and keyed BLAKE2, the
 * workspace's docs/crypto.md §6.4): standard vectors, the parameters, the
 * key slot table, and MAC frames under the interpreter
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { struct, list, u8, u16, named, buildTypeGraph, matchType } from "../../src/core/index"
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
import type { CryptoParam } from "../../src/codecs/engine/crypto/crypto"
import { createCryptoContext, integerParamBytes, stringParamBytes } from "../../src/codecs/engine/crypto/crypto"
import { FIXED_HASHES } from "../../src/codecs/engine/crypto/hashes"
import { MAC_NAMES } from "../../src/codecs/engine/crypto/macs"
import { keySlots, bindKeys } from "../../src/codecs/engine/crypto/keys"

const int = (name: string, v: number): CryptoParam => ({ name, value: integerParamBytes(v) })
const bytes = (name: string, v: readonly number[]): CryptoParam => ({ name, value: v })
const str = (name: string, v: string): CryptoParam => ({ name, value: stringParamBytes(v) })
const text = (s: string): number[] => [...Buffer.from(s)]
const fill = (n: number, b: number): Uint8Array => new Uint8Array(n).fill(b)
const counting = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => from + i)

function mac(alg: string, params: readonly CryptoParam[], key: Uint8Array, data: readonly number[], chunks: readonly number[] = [data.length]): string
{
    const c = createCryptoContext(alg, [...params, str("key", "k")], new Map([["k", key]]))
    let at = 0
    for(const n of chunks) { c.absorb(data, at, at + n); at += n }
    return Buffer.from(c.final()).toString("hex")
}

const jefe = Uint8Array.from(text("Jefe"))
const wantForNothing = text("what do ya want for nothing?")
const largerKey = text("Test Using Larger Than Block-Size Key - Hash Key First")

/** RFC 2202 and RFC 4231, test cases 2 and 6. */
const HMAC_VECTORS: readonly (readonly [string, Uint8Array, readonly number[], string])[] = [
    ["HMAC-MD5", jefe, wantForNothing, "750c783e6ab0b503eaa86e310a5db738"],
    ["HMAC-SHA-1", jefe, wantForNothing, "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"],
    ["HMAC-SHA-224", jefe, wantForNothing, "a30e01098bc6dbbf45690f3a7e9e6d0f8bbea2a39e6148008fd05e44"],
    ["HMAC-SHA-256", jefe, wantForNothing, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
    ["HMAC-SHA-384", jefe, wantForNothing, "af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240ca5e69e2c78b3239ecfab21649"],
    ["HMAC-SHA-512", jefe, wantForNothing, "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"],
    ["HMAC-MD5", fill(80, 0xaa), largerKey, "6b1ab7fe4bd7bf8f0b62e6ce61b9d0cd"],
    ["HMAC-SHA-1", fill(80, 0xaa), largerKey, "aa4ae5e15272d00e95705637ce8a3b55ed402112"],
    ["HMAC-SHA-224", fill(131, 0xaa), largerKey, "95e9a0db962095adaebe9b2d6f0dbce2d499f112f2d2b7273fa6870e"],
    ["HMAC-SHA-256", fill(131, 0xaa), largerKey, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
    ["HMAC-SHA-384", fill(131, 0xaa), largerKey, "4ece084485813e9088d2c63a041bc5b44f9ef1012a2b588f3cd11f05033ac4c60c2ef6ab4030fe8296248df163f44952"],
    ["HMAC-SHA-512", fill(131, 0xaa), largerKey, "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598"],
]

const NODE_NAME = (hash: string): string => hash.replace(/^SHA-(?=\d)/, "sha").replace("/", "-").toLowerCase()

const kmacKey = counting(32, 0x40)
const tagged = text("My Tagged Application")

describe("MACs — known answers", () =>
{
    for(const [alg, key, data, hex] of HMAC_VECTORS)
        test(`${alg}, ${key.length}-byte key`, () => assert.equal(mac(alg, [], key, data), hex))

    test("every HMAC-<hash> agrees with node:crypto, under a short and a long key", () =>
    {
        const data = Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff)
        for(const hash of FIXED_HASHES.keys())
            for(const key of [jefe, fill(200, 0x5c)])
                assert.equal(mac(`HMAC-${hash}`, [], key, data),
                    createHmac(NODE_NAME(hash), key).update(Buffer.from(data)).digest("hex"), `HMAC-${hash}`)
    })

    test("every name MAC_NAMES lists resolves", () =>
    {
        for(const alg of MAC_NAMES)
            assert.doesNotThrow(() => mac(alg, alg.startsWith("KMAC") ? [int("out_len", 32)] : [], jefe, []), alg)
    })

    test("KMAC: SP 800-185 samples 1, 2 and 4", () =>
    {
        const data = [0, 1, 2, 3]
        assert.equal(mac("KMAC128", [int("out_len", 32)], kmacKey, data),
            "e5780b0d3ea6f7d3a429c5706aa43a00fadbd7d49628839e3187243f456ee14e")
        assert.equal(mac("KMAC128", [int("out_len", 32), bytes("customization", tagged)], kmacKey, data),
            "3b1fba963cd8b0b59e8c1a6d71888b7143651af8ba0a7070c0979e2811324aa5")
        assert.equal(mac("KMAC256", [int("out_len", 64), bytes("customization", tagged)], kmacKey, data),
            "20c570c31346f703c9ac36c61c03cb64c3970d0cfc787e9b79599d273a68d2f7f69d4cc3de9d104a351689f27cf6f5951f0103f33f4f24871024d9c27773a8dd")
    })

    test("keyed BLAKE2: the BLAKE2 KAT's first entry", () =>
    {
        assert.equal(mac("BLAKE2b", [], counting(64), []),
            "10ebb67700b1868efb4417987acf4690ae9d972fb7a590c2f02871799aaa4786b5e996e8f0f4eb981fc214b005f42d2ff4233499391653df7aefcbc13fc51568")
        assert.equal(mac("BLAKE2s", [], counting(32), []),
            "48a8997da407876b3d79c0d92325ad3b89cbb754d86ab71aee047ad345fd2c49")
    })

    test("absorbing in chunks gives the one-shot tag", () =>
    {
        const data = Array.from({ length: 1000 }, (_, i) => (i * 131) & 0xff)
        for(const [alg, params] of [["HMAC-SHA-256", []], ["KMAC256", [int("out_len", 48)]], ["BLAKE2s", []]] as const)
            assert.equal(mac(alg, params, jefe, data, [1, 63, 64, 0, 872]), mac(alg, params, jefe, data), alg)
    })
})

describe("MACs — parameters", () =>
{
    const key0 = str("key", "k")
    const table = (key: Uint8Array) => new Map([["k", key]])
    const init = (alg: string, params: readonly CryptoParam[], keys: ReadonlyMap<string, Uint8Array> = table(jefe)) =>
        () => createCryptoContext(alg, params, keys)

    test("tag_len truncates an HMAC to its prefix", () =>
    {
        assert.equal(mac("HMAC-SHA-256", [int("tag_len", 12)], jefe, wantForNothing), HMAC_VECTORS[3]![3].slice(0, 24))
    })

    test("a missing, unknown or out-of-range parameter is a hard error", () =>
    {
        assert.throws(init("HMAC-SHA-256", []), /HMAC-SHA-256: missing parameter "key"/)
        assert.throws(init("KMAC128", [key0]), /KMAC128: missing parameter "out_len"/)
        assert.throws(init("KMAC128", [key0, int("out_len", 16), int("tag_len", 8)]), /unknown parameter "tag_len"/)
        assert.throws(init("HMAC-SHA-256", [key0, int("out_len", 16)]), /unknown parameter "out_len"/)
        assert.throws(init("HMAC-SHA-256", [key0, int("tag_len", 33)]), /"tag_len" must be 1\.\.32/)
        assert.throws(init("HMAC-SHA-256", [key0, key0]), /given twice/)
        assert.throws(init("HMAC-SHA-256", [bytes("key", [])]), /"key" names a slot, and is empty/)
        assert.throws(init("HMAC-SHA-256", [bytes("key", [0xff])]), /"key" names a slot, and is not UTF-8/)
    })

    test("a name is compared exactly, and SHAKE has no HMAC", () =>
    {
        for(const name of ["HMAC-SHAKE128", "HMAC-sha-256", "HMAC_SHA-256", "HMAC-SHA256", "kmac128"])
            assert.throws(init(name, [key0]), /unknown algorithm/, name)
    })

    test("a missing key, or one of the wrong length, is a host error", () =>
    {
        assert.throws(init("HMAC-SHA-256", [key0], new Map()), /key slot "k": HMAC-SHA-256 needs a key of at least 1 byte\(s\), none bound/)
        assert.throws(init("HMAC-SHA-256", [str("key", "K")]), /key slot "K": .* none bound/)
        assert.throws(init("HMAC-SHA-256", [key0], table(new Uint8Array(0))), /at least 1 byte\(s\), not 0/)
        assert.throws(init("BLAKE2s", [key0], table(counting(33))), /BLAKE2s needs a key of 1\.\.32 bytes, not 33/)
        assert.throws(init("BLAKE2b", [key0], table(counting(65))), /BLAKE2b needs a key of 1\.\.64 bytes, not 65/)
    })

    test("a slot role takes a string in crypto_init, and nothing else does", () =>
    {
        const lower = (body: ReturnType<typeof ir>) => lowerProgram(proc([], body), { rules: codecRules })
        const initOf = (body: ReturnType<typeof ir>) => lower(body).procedures[0]!.body.find(i => "ext" in i && i.ext === "INIT")
        assert.deepEqual(initOf(ir`crypto_init(0, "HMAC-SHA-256", "key", "sensor-mac", "tag_len", 12); return;`),
            initInstr(0, "HMAC-SHA-256", [{ name: "key", value: text("sensor-mac") }, { name: "tag_len", value: [12] }]))
        assert.throws(() => lower(ir`crypto_init(0, "HMAC-SHA-256", "key", 0); return;`), /"key" names a slot; its value is a string/)
        assert.throws(() => lower(ir`crypto_init(0, "HMAC-SHA-256", "key", x"41"); return;`), /"key" names a slot; its value is a string/)
        assert.throws(() => lower(ir`crypto_init(0, "HMAC-SHA-256", "key", "k", "tag_len", "12"); return;`), /"tag_len" is a string; only a slot role \(key\) takes one/)
    })
})

const Packet = named("Packet", struct({ id: u8, samples: list(u16) }))
const value = { id: 7, samples: [1, 0x1234, 0xffff] }
const TRAP_MAC = 0x53

const ruleFor = (rules: readonly CodecRule<void>[]): CodecRule<void> => rules.find(r => matchType(Packet, r.pattern) !== undefined)!
const encodeProgram = (spec: FrameSpec | undefined) =>
    buildCodec(Packet, spec ? [framedEncode(spec, ruleFor(binaryEncodeRules), "Packet"), ...binaryEncodeRules] : binaryEncodeRules, undefined)
const decodeProgram = (spec: FrameSpec) =>
    buildCodec(Packet, [framedDecode(spec, ruleFor(binaryDecodeRules), "Packet"), ...binaryDecodeRules], undefined)

function encode(spec: FrameSpec | undefined, keys: ReadonlyMap<string, Uint8Array> = new Map()): number[]
{
    const program = encodeProgram(spec)
    const buffer: number[] = []
    const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: buildTypeGraph(Packet).root }, buffer, keys)
    validateProgram(program, ext)
    validateCodecHandles(program)
    assert.equal(run(program, ext).ok, true)
    return buffer
}

function decode(spec: FrameSpec, wire: readonly number[], keys: ReadonlyMap<string, Uint8Array>): { result: VmResult; value: unknown }
{
    const program = decodeProgram(spec)
    const wrapper: Record<string, unknown> = { root: {} }
    const ext = createCodecExtension("decode", { container: wrapper, key: "root", type: buildTypeGraph(Packet).root }, [...wire], keys)
    validateProgram(program, ext)
    validateCodecHandles(program)
    return { result: run(program, ext), value: wrapper.root }
}

const paramsOf = (spec: FrameSpec): CryptoParam[] =>
    Object.entries(spec.params ?? {}).map(([name, v]) => typeof v === "number" ? int(name, v) : typeof v === "string" ? str(name, v) : bytes(name, v))

describe("key slots", () =>
{
    const hmac: FrameSpec = { alg: "HMAC-SHA-256", params: { key: "uplink" }, code: TRAP_MAC }

    test("one requirement per slot, from either direction's INITs", () =>
    {
        const kmac: FrameSpec = { alg: "KMAC128", params: { key: "telemetry", out_len: 16 }, code: TRAP_MAC }
        const blake: FrameSpec = { alg: "BLAKE2s", params: { key: "config" }, code: TRAP_MAC }
        assert.deepEqual(keySlots([encodeProgram(kmac), decodeProgram(blake)]), [
            { alg: "BLAKE2s", slot: "config", minLen: 1, maxLen: 32 },
            { alg: "KMAC128", slot: "telemetry", minLen: 1, maxLen: Infinity },
        ])
        assert.deepEqual(keySlots([encodeProgram(hmac), decodeProgram(hmac)]), [{ alg: "HMAC-SHA-256", slot: "uplink", minLen: 1, maxLen: Infinity }])
        assert.deepEqual(keySlots([encodeProgram({ alg: "SHA-256", code: TRAP_MAC })]), [])
    })

    test("one slot under two algorithms is an error", () =>
    {
        const blake: FrameSpec = { alg: "BLAKE2s", params: { key: "uplink" }, code: TRAP_MAC }
        assert.throws(() => keySlots([encodeProgram(hmac), decodeProgram(blake)]),
            /key slot "uplink" is used by both HMAC-SHA-256 and BLAKE2s; one key, one algorithm/)
    })

    test("bindKeys rejects a missing slot or a key of the wrong length", () =>
    {
        const slots = keySlots([encodeProgram({ alg: "BLAKE2s", params: { key: "config" }, code: TRAP_MAC })])
        assert.doesNotThrow(() => bindKeys(slots, new Map([["config", counting(32)], ["unused", counting(1)]])))
        assert.throws(() => bindKeys(slots, new Map([["Config", counting(32)]])), /key slot "config": BLAKE2s needs a key of 1\.\.32 bytes, none bound/)
        assert.throws(() => bindKeys(slots, undefined), /none bound/)
        assert.throws(() => bindKeys(slots, new Map([["config", counting(40)]])), /not 40/)
    })
})

describe("MAC frame — under the interpreter", () =>
{
    const specs: readonly FrameSpec[] = [
        { alg: "HMAC-SHA-256", params: { key: "uplink" }, code: TRAP_MAC },
        { alg: "HMAC-SHA3-384", params: { key: "uplink", tag_len: 16 }, code: TRAP_MAC },
        { alg: "KMAC256", params: { key: "uplink", out_len: 20, customization: text("ppl-test") }, code: TRAP_MAC },
        { alg: "BLAKE2b", params: { key: "uplink", out_len: 16 }, code: TRAP_MAC },
    ]
    const keys = new Map([["uplink", counting(32, 0x10)]])
    const otherKeys = new Map([["uplink", counting(32, 0x11)]])

    for(const spec of specs)
    {
        const label = `${spec.alg} ${JSON.stringify(spec.params)}`

        test(`${label}: the tag of the unframed bytes, then those bytes, and a round trip`, () =>
        {
            const body = encode(undefined)
            const wire = encode(spec, keys)
            assert.deepEqual(wire, [...Buffer.from(mac(spec.alg, paramsOf(spec).filter(p => p.name !== "key"), keys.get("uplink")!, body), "hex"), ...body])
            const { result, value: decoded } = decode(spec, wire, keys)
            assert.equal(result.ok, true)
            assert.deepEqual(decoded, value)
        })

        test(`${label}: every single-bit flip, and a different key, traps with the frame's code`, () =>
        {
            const good = encode(spec, keys)
            assert.equal(decode(spec, good, otherKeys).result.trapCode, TRAP_MAC)
            for(let byte = 0; byte < good.length; byte++)
                for(let bit = 0; bit < 8; bit++)
                {
                    const bad = [...good]
                    bad[byte]! ^= 1 << bit
                    assert.equal(decode(spec, bad, keys).result.trapCode, TRAP_MAC, `byte ${byte} bit ${bit}`)
                }
        })
    }

    test("a frame whose slot is unbound fails at INIT, as a host error", () =>
    {
        assert.throws(() => encode(specs[0]!, new Map()), /key slot "uplink": HMAC-SHA-256 needs a key of at least 1 byte\(s\), none bound/)
    })
})
