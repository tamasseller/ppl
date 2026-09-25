/**
 * codecs — Crypto contexts behind `INIT`/`ABSORB`/`FINAL`/`VERIFY`
 * (the workspace's docs/crypto.md, "Crypto primitives")
 *
 * One implementation, shared by the interpreter (`codec-extension.ts`) and
 * generated code (`target-js`'s runtime). An algorithm name resolves to a
 * family: hashes in `./hashes.ts`, MACs in `./macs.ts`, CRCs in `./crc.ts`.
 */

import { hashSpec } from "./hashes"
import { macSpec } from "./macs"
import { crcSpec } from "./crc"

/** One `INIT` parameter as the wire carries it: its value's meaning is
 *  fixed by its name, so the bytes stay uninterpreted until a context
 *  reads them. An integer is unsigned little-endian. */
export interface CryptoParam
{
    readonly name: string
    readonly value: readonly number[]
}

export interface CryptoContext
{
    /** Bytes `from` (inclusive) to `to` (exclusive) of `bytes`. */
    absorb(bytes: ArrayLike<number>, from: number, to: number): void
    /** The result's wire length, fixed by configuration. */
    readonly outLen: number
    /** The result's wire bytes; the context is spent afterwards. */
    final(): number[]
}

/** Parameters whose value names a slot; theirs alone is a string. */
export const SLOT_ROLES: ReadonlySet<string> = new Set(["key"])

/** A string parameter's UTF-8 bytes. */
export const stringParamBytes = (value: string): number[] => [...Buffer.from(value, "utf8")]

/** An integer parameter's little-endian bytes, as short as the value allows. */
export function integerParamBytes(value: number | bigint): number[]
{
    let v = BigInt(value)
    if(v < 0n) throw new Error(`crypto: integer parameter ${value} is negative`)
    const bytes: number[] = []
    for(; v > 0n; v >>= 8n) bytes.push(Number(v & 0xffn))
    return bytes
}

/** What a keyed configuration needs bound in its `key` slot. */
export interface KeyRequirement
{
    readonly alg: string
    readonly slot: string
    readonly minLen: number
    readonly maxLen: number
}

/** A configuration resolved once: its table, and a factory for contexts. */
export interface CryptoSpec
{
    /** The result's wire length. */
    readonly outLen: number
    /** Present exactly when the configuration is keyed. */
    readonly key?: KeyRequirement
    /** `key` is the bound slot's bytes, required exactly when `this.key` is. */
    create(key?: Uint8Array): CryptoContext
}

/** Keys by slot name. */
export type KeyTable = ReadonlyMap<string, Uint8Array>

/** Slot `req.slot`'s key in `keys`, checked against `req`. */
export function keyFor(req: KeyRequirement, keys: KeyTable | undefined): Uint8Array
{
    const key = keys?.get(req.slot)
    const range = req.maxLen === Infinity ? `at least ${req.minLen} byte(s)` : `${req.minLen}..${req.maxLen} bytes`
    if(key === undefined) throw new Error(`crypto: key slot "${req.slot}": ${req.alg} needs a key of ${range}, none bound`)
    if(key.length < req.minLen || key.length > req.maxLen)
        throw new Error(`crypto: key slot "${req.slot}": ${req.alg} needs a key of ${range}, not ${key.length}`)
    return key
}

const SPECS = new Map<string, CryptoSpec>()

/** `alg` under `params`, validated and resolved once per configuration;
 *  throws on anything not implemented, which is how codegen checks one. */
export function cryptoSpec(alg: string, params: readonly CryptoParam[]): CryptoSpec
{
    const key = `${alg}\0${params.map(p => `${p.name}=${p.value.join(",")}`).join(";")}`
    let spec = SPECS.get(key)
    if(!spec)
    {
        spec = hashSpec(alg, params) ?? macSpec(alg, params) ?? crcSpec(alg, params)
        SPECS.set(key, spec)
    }
    return spec
}

export function createCryptoContext(alg: string, params: readonly CryptoParam[], keys?: KeyTable): CryptoContext
{
    const spec = cryptoSpec(alg, params)
    return spec.create(spec.key && keyFor(spec.key, keys))
}
