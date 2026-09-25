/**
 * codecs — Keyless hashes behind the crypto ops (the workspace's
 * docs/crypto.md §4.2), provided by `@noble/hashes`
 *
 * A keyless digest gives integrity against accident, never authenticity;
 * BLAKE2 under `key` is a MAC (§4.3).
 * `@noble/hashes` is pinned to 1.x, the last line that loads from this
 * CommonJS package.
 */

import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from "@noble/hashes/sha2"
import { sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from "@noble/hashes/sha3"
import { blake2b, blake2s } from "@noble/hashes/blake2"
import { md5, sha1 } from "@noble/hashes/legacy"
import type { CHash } from "@noble/hashes/utils"
import type { CryptoContext, CryptoParam, CryptoSpec, KeyRequirement } from "./crypto"

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
    key?: Uint8Array
}

type Family =
    /** Fixed digest length, optionally truncated by `tag_len`. */
    | { readonly kind: "fixed"; readonly natural: number; readonly hash: CHash }
    /** `out_len` required: a XOF's length is always contractual. */
    | { readonly kind: "xof"; create(opts: HashOptions): NobleHash }
    /** `out_len` up to `natural`, and fixed-size `salt`/`personal`. */
    | { readonly kind: "blake2"; readonly natural: number; readonly saltLen: number; create(opts: HashOptions): NobleHash }

const fixed = (natural: number, hash: CHash): Family => ({ kind: "fixed", natural, hash })

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

/** The fixed-length hashes, by name, with their natural digest length. */
export const FIXED_HASHES: ReadonlyMap<string, { readonly natural: number; readonly hash: CHash }> =
    new Map([...HASHES].flatMap(([name, f]) => f.kind === "fixed" ? [[name, f] as const] : []))

const integerOf = (value: readonly number[]): number =>
    value.reduceRight((acc, b) => acc * 256 + b, 0)

export function lengthParam(alg: string, name: string, value: readonly number[], max: number): number
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

const UTF8 = new TextDecoder("utf-8", { fatal: true })

/** `key`'s slot name, with the key length `alg` accepts in it. */
export function keyParam(alg: string, value: readonly number[], maxLen: number): KeyRequirement
{
    let slot: string
    try { slot = UTF8.decode(Uint8Array.from(value)) }
    catch { throw new Error(`crypto: ${alg}: "key" names a slot, and is not UTF-8`) }
    if(slot === "") throw new Error(`crypto: ${alg}: "key" names a slot, and is empty`)
    return { alg, slot, minLen: 1, maxLen }
}

/** `params` by name, each at most once and each in `allowed`. */
export function paramsByName(alg: string, params: readonly CryptoParam[], allowed: readonly string[]): Map<string, readonly number[]>
{
    const given = new Map<string, readonly number[]>()
    for(const p of params)
    {
        if(given.has(p.name)) throw new Error(`crypto: ${alg}: parameter "${p.name}" given twice`)
        if(!allowed.includes(p.name)) throw new Error(`crypto: ${alg}: unknown parameter "${p.name}"`)
        given.set(p.name, p.value)
    }
    return given
}

/** The keyed spec's factory, refusing a call without the key it needs. */
export function keyed(req: KeyRequirement, create: (key: Uint8Array) => CryptoContext): (key?: Uint8Array) => CryptoContext
{
    return key =>
    {
        if(key === undefined || key.length < req.minLen || key.length > req.maxLen)
            throw new Error(`crypto: ${req.alg}: key slot "${req.slot}"'s key is missing or of the wrong length`)
        return create(key)
    }
}

/** `bytes[from..to)` without a copy where the stream is already bytes. */
const rangeOf = (bytes: ArrayLike<number>, from: number, to: number): Uint8Array =>
    bytes instanceof Uint8Array ? bytes.subarray(from, to) : Uint8Array.from(Array.prototype.slice.call(bytes, from, to) as number[])

export function hashContext(outLen: number, h: NobleHash): CryptoContext
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

    const allowed = family.kind === "fixed" ? ["tag_len"] : family.kind === "xof" ? ["out_len"] : ["out_len", "salt", "personal", "key"]
    const given = paramsByName(alg, params, allowed)

    switch(family.kind)
    {
        case "fixed":
        {
            const tag = given.get("tag_len")
            const outLen = tag === undefined ? family.natural : lengthParam(alg, "tag_len", tag, family.natural)
            return { outLen, create: () => hashContext(outLen, family.hash.create()) }
        }
        case "xof":
        {
            const out = given.get("out_len")
            if(out === undefined) throw new Error(`crypto: ${alg}: missing parameter "out_len"`)
            const outLen = lengthParam(alg, "out_len", out, 0xffff)
            return { outLen, create: () => hashContext(outLen, family.create({ dkLen: outLen })) }
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
            const key = given.get("key")
            if(key === undefined) return { outLen, create: () => hashContext(outLen, family.create(opts)) }
            const req = keyParam(alg, key, family.natural)
            return { outLen, key: req, create: keyed(req, k => hashContext(outLen, family.create({ ...opts, key: k }))) }
        }
    }
}
