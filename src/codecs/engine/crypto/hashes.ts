/**
 * codecs — Keyless hashes behind the crypto ops (the workspace's
 * docs/crypto.md §4.2), provided by `@noble/hashes`
 *
 * A keyless digest gives integrity against accident, never authenticity.
 * `@noble/hashes` is pinned to 1.x, the last line that loads from this
 * CommonJS package.
 */

import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from "@noble/hashes/sha2"
import { sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from "@noble/hashes/sha3"
import { blake2b, blake2s } from "@noble/hashes/blake2"
import { md5, sha1 } from "@noble/hashes/legacy"
import type { CryptoContext, CryptoParam, CryptoSpec } from "./crypto"

/** What `@noble/hashes`' `create()` hands back. */
interface NobleHash
{
    update(data: Uint8Array): unknown
    digest(): Uint8Array
}

interface HashOptions
{
    dkLen?: number
    salt?: Uint8Array
    personalization?: Uint8Array
}

type Family =
    /** Fixed digest length, optionally truncated by `tag_len`. */
    | { readonly kind: "fixed"; readonly natural: number; create(): NobleHash }
    /** `out_len` required: a XOF's length is always contractual. */
    | { readonly kind: "xof"; create(opts: HashOptions): NobleHash }
    /** `out_len` up to `natural`, and fixed-size `salt`/`personal`. */
    | { readonly kind: "blake2"; readonly natural: number; readonly saltLen: number; create(opts: HashOptions): NobleHash }

const fixed = (natural: number, h: { create(): NobleHash }): Family =>
    ({ kind: "fixed", natural, create: () => h.create() })

const HASHES: ReadonlyMap<string, Family> = new Map<string, Family>([
    ["MD5", fixed(16, md5)],
    ["SHA-1", fixed(20, sha1)],
    ["SHA-224", fixed(28, sha224)],
    ["SHA-256", fixed(32, sha256)],
    ["SHA-384", fixed(48, sha384)],
    ["SHA-512", fixed(64, sha512)],
    ["SHA-512/224", fixed(28, sha512_224)],
    ["SHA-512/256", fixed(32, sha512_256)],
    ["SHA3-224", fixed(28, sha3_224)],
    ["SHA3-256", fixed(32, sha3_256)],
    ["SHA3-384", fixed(48, sha3_384)],
    ["SHA3-512", fixed(64, sha3_512)],
    ["SHAKE128", { kind: "xof", create: opts => shake128.create(opts) }],
    ["SHAKE256", { kind: "xof", create: opts => shake256.create(opts) }],
    ["BLAKE2b", { kind: "blake2", natural: 64, saltLen: 16, create: opts => blake2b.create(opts) }],
    ["BLAKE2s", { kind: "blake2", natural: 32, saltLen: 8, create: opts => blake2s.create(opts) }],
])

/** Every name this file implements, in the spelling `INIT` must use. */
export const HASH_NAMES: readonly string[] = [...HASHES.keys()]

const integerOf = (value: readonly number[]): number =>
    value.reduceRight((acc, b) => acc * 256 + b, 0)

function lengthParam(alg: string, name: string, value: readonly number[], max: number): number
{
    const n = integerOf(value)
    if(n < 1 || n > max) throw new Error(`crypto: ${alg}: "${name}" must be 1..${max}, not ${n}`)
    return n
}

function bytesParam(alg: string, name: string, value: readonly number[], size: number): Uint8Array
{
    if(value.length !== size) throw new Error(`crypto: ${alg}: "${name}" must be ${size} bytes, not ${value.length}`)
    return Uint8Array.from(value)
}

/** `bytes[from..to)` without a copy where the stream is already bytes. */
const rangeOf = (bytes: ArrayLike<number>, from: number, to: number): Uint8Array =>
    bytes instanceof Uint8Array ? bytes.subarray(from, to) : Uint8Array.from(Array.prototype.slice.call(bytes, from, to) as number[])

function context(outLen: number, h: NobleHash): CryptoContext
{
    let spent = false
    return {
        outLen,
        absorb(bytes, from, to)
        {
            if(spent) throw new Error(`crypto: ABSORB into a finished context`)
            if(to > from) h.update(rangeOf(bytes, from, to))
        },
        final()
        {
            if(spent) throw new Error(`crypto: context finished twice`)
            spent = true
            return Array.from(h.digest().subarray(0, outLen))
        },
    }
}

/** `alg`'s spec under `params`, or `undefined` if `alg` is no hash here. */
export function hashSpec(alg: string, params: readonly CryptoParam[]): CryptoSpec | undefined
{
    const family = HASHES.get(alg)
    if(!family) return undefined

    const allowed = family.kind === "fixed" ? ["tag_len"] : family.kind === "xof" ? ["out_len"] : ["out_len", "salt", "personal"]
    const given = new Map<string, readonly number[]>()
    for(const p of params)
    {
        if(given.has(p.name)) throw new Error(`crypto: ${alg}: parameter "${p.name}" given twice`)
        if(!allowed.includes(p.name)) throw new Error(`crypto: ${alg}: unknown parameter "${p.name}"`)
        given.set(p.name, p.value)
    }

    switch(family.kind)
    {
        case "fixed":
        {
            const tag = given.get("tag_len")
            const outLen = tag === undefined ? family.natural : lengthParam(alg, "tag_len", tag, family.natural)
            return { outLen, create: () => context(outLen, family.create()) }
        }
        case "xof":
        {
            const out = given.get("out_len")
            if(out === undefined) throw new Error(`crypto: ${alg}: missing parameter "out_len"`)
            const outLen = lengthParam(alg, "out_len", out, 0xffff)
            return { outLen, create: () => context(outLen, family.create({ dkLen: outLen })) }
        }
        case "blake2":
        {
            const out = given.get("out_len")
            const outLen = out === undefined ? family.natural : lengthParam(alg, "out_len", out, family.natural)
            const salt = given.get("salt")
            const personal = given.get("personal")
            const opts: HashOptions = {
                dkLen: outLen,
                ...(salt === undefined ? {} : { salt: bytesParam(alg, "salt", salt, family.saltLen) }),
                ...(personal === undefined ? {} : { personalization: bytesParam(alg, "personal", personal, family.saltLen) }),
            }
            return { outLen, create: () => context(outLen, family.create(opts)) }
        }
    }
}
