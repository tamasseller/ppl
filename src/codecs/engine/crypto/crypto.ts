/**
 * codecs — Crypto contexts behind `INIT`/`ABSORB`/`FINAL`/`VERIFY`
 * (the workspace's docs/crypto.md, "Crypto primitives")
 *
 * One implementation, shared by the interpreter (`codec-extension.ts`) and
 * generated code (`target-js`'s runtime). An algorithm name resolves to a
 * family: keyless hashes in `./hashes.ts`, CRCs in `./crc.ts`.
 */

import { hashSpec } from "./hashes"
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

/** An integer parameter's little-endian bytes, as short as the value allows. */
export function integerParamBytes(value: number | bigint): number[]
{
    let v = BigInt(value)
    if(v < 0n) throw new Error(`crypto: integer parameter ${value} is negative`)
    const bytes: number[] = []
    for(; v > 0n; v >>= 8n) bytes.push(Number(v & 0xffn))
    return bytes
}

/** A configuration resolved once: its table, and a factory for contexts. */
export interface CryptoSpec
{
    /** The result's wire length. */
    readonly outLen: number
    create(): CryptoContext
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
        spec = hashSpec(alg, params) ?? crcSpec(alg, params)
        SPECS.set(key, spec)
    }
    return spec
}

export function createCryptoContext(alg: string, params: readonly CryptoParam[]): CryptoContext
{
    return cryptoSpec(alg, params).create()
}
