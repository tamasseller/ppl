/**
 * codecs — Crypto contexts behind `INIT`/`ABSORB`/`FINAL`/`VERIFY`
 * (the workspace's docs/crypto.md, "Crypto primitives")
 *
 * One implementation, shared by the interpreter (`codec-extension.ts`) and
 * generated code (`target-js`'s runtime). Stage 1: CRCs only, by RevEng
 * catalogue name or as `"CRC"` with the Rocksoft parameters.
 */

import { CRC_CATALOGUE } from "./crc-catalogue"
import type { CrcCatalogueEntry } from "./crc-catalogue"

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

const integerOf = (value: readonly number[]): bigint =>
    value.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n)

const ROCKSOFT = ["width", "poly", "init", "refin", "refout", "xorout"] as const

const CANONICAL = new Map<string, CrcCatalogueEntry>(CRC_CATALOGUE.map(e => [e.name, e]))
const ALIAS_OF = new Map<string, string>(CRC_CATALOGUE.flatMap(e => e.aliases.map(a => [a, e.name] as const)))

interface CrcModel
{
    readonly width: number
    readonly poly: bigint
    readonly init: bigint
    readonly refin: boolean
    readonly refout: boolean
    readonly xorout: bigint
    /** `true` for big-endian on the wire. */
    readonly bigEndian: boolean
}

function paramMap(alg: string, params: readonly CryptoParam[]): Map<string, bigint>
{
    const out = new Map<string, bigint>()
    for(const p of params)
    {
        if(out.has(p.name)) throw new Error(`crypto: ${alg}: parameter "${p.name}" given twice`)
        out.set(p.name, integerOf(p.value))
    }
    return out
}

function booleanParam(alg: string, name: string, v: bigint): boolean
{
    if(v !== 0n && v !== 1n) throw new Error(`crypto: ${alg}: "${name}" must be 0 or 1, not ${v}`)
    return v === 1n
}

function crcModel(alg: string, params: readonly CryptoParam[]): CrcModel
{
    const given = paramMap(alg, params)
    const canonical = ALIAS_OF.get(alg)
    if(canonical !== undefined) throw new Error(`crypto: "${alg}" is an alias; name it by its catalogue entry, "${canonical}"`)

    const allowed: readonly string[] = alg === "CRC" ? [...ROCKSOFT, "byteorder"] : ["byteorder"]
    for(const name of given.keys())
        if(!allowed.includes(name)) throw new Error(`crypto: ${alg}: unknown parameter "${name}"`)

    let base: Omit<CrcModel, "bigEndian">
    if(alg === "CRC")
    {
        for(const name of ROCKSOFT)
            if(!given.has(name)) throw new Error(`crypto: CRC: missing parameter "${name}"`)
        const width = Number(given.get("width")!)
        if(width < 1) throw new Error(`crypto: CRC: width must be at least 1`)
        base = {
            width,
            poly: given.get("poly")!, init: given.get("init")!, xorout: given.get("xorout")!,
            refin: booleanParam(alg, "refin", given.get("refin")!),
            refout: booleanParam(alg, "refout", given.get("refout")!),
        }
        const limit = 1n << BigInt(width)
        for(const name of ["poly", "init", "xorout"] as const)
            if(base[name] >= limit) throw new Error(`crypto: CRC: "${name}" does not fit in ${width} bits`)
    }
    else
    {
        const entry = CANONICAL.get(alg)
        if(!entry) throw new Error(`crypto: unknown algorithm "${alg}"`)
        base = entry
    }

    const order = given.get("byteorder")
    const bigEndian = order === undefined ? !base.refout : booleanParam(alg, "byteorder", order)
    return { ...base, bigEndian }
}

function reflect(v: bigint, bits: number): bigint
{
    let r = 0n
    for(let i = 0; i < bits; i++, v >>= 1n) r = (r << 1n) | (v & 1n)
    return r
}

/** Table-driven Rocksoft model over any width. A register narrower than a
 *  byte runs left-aligned in 8 bits, unreflected. */
function crcContext(m: CrcModel): CryptoContext
{
    const table: bigint[] = new Array(256)
    let reg: bigint
    let step: (b: number) => void
    let result: () => bigint

    if(m.refin)
    {
        const rpoly = reflect(m.poly, m.width)
        for(let i = 0; i < 256; i++)
        {
            let c = BigInt(i)
            for(let k = 0; k < 8; k++) c = (c & 1n) ? (c >> 1n) ^ rpoly : c >> 1n
            table[i] = c
        }
        reg = reflect(m.init, m.width)
        step = b => { reg = (reg >> 8n) ^ table[Number((reg ^ BigInt(b)) & 0xffn)]! }
        result = () => m.refout ? reg : reflect(reg, m.width)
    }
    else
    {
        const w = Math.max(m.width, 8)
        const shift = BigInt(w - m.width)
        const hi = BigInt(w - 8)
        const top = 1n << BigInt(w - 1)
        const mask = (1n << BigInt(w)) - 1n
        const poly = m.poly << shift
        for(let i = 0; i < 256; i++)
        {
            let c = BigInt(i) << hi
            for(let k = 0; k < 8; k++) c = (c & top) ? ((c << 1n) ^ poly) & mask : (c << 1n) & mask
            table[i] = c
        }
        reg = m.init << shift
        step = b => { reg = ((reg << 8n) & mask) ^ table[Number(((reg >> hi) ^ BigInt(b)) & 0xffn)]! }
        result = () => { const crc = reg >> shift; return m.refout ? reflect(crc, m.width) : crc }
    }

    const outLen = Math.ceil(m.width / 8)
    let spent = false

    return {
        outLen,
        absorb(bytes, from, to)
        {
            if(spent) throw new Error(`crypto: ABSORB into a finished context`)
            for(let i = from; i < to; i++) step(bytes[i] ?? 0)
        },
        final()
        {
            if(spent) throw new Error(`crypto: context finished twice`)
            spent = true
            let v = result() ^ m.xorout
            const le: number[] = []
            for(let i = 0; i < outLen; i++, v >>= 8n) le.push(Number(v & 0xffn))
            return m.bigEndian ? le.reverse() : le
        },
    }
}

/** A fresh context for `alg` configured by `params`; throws on anything it
 *  does not implement, which is also how codegen checks a configuration. */
export function createCryptoContext(alg: string, params: readonly CryptoParam[]): CryptoContext
{
    return crcContext(crcModel(alg, params))
}

/** The integer CRC of `bytes` under `alg`, `xorout` applied — what a
 *  catalogue entry's `check` names. */
export function crcValue(alg: string, params: readonly CryptoParam[], bytes: ArrayLike<number>): bigint
{
    const ctx = crcContext({ ...crcModel(alg, params), bigEndian: false })
    ctx.absorb(bytes, 0, bytes.length)
    return integerOf(ctx.final())
}
