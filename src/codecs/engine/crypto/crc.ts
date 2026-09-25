/**
 * codecs — CRCs behind the crypto ops (the workspace's docs/crypto.md §4.1):
 * a RevEng catalogue name, or `"CRC"` with the six Rocksoft parameters and
 * an optional `byteorder`
 */

import { CRC_CATALOGUE } from "./crc-catalogue"
import type { CrcCatalogueEntry } from "./crc-catalogue"
import type { CryptoContext, CryptoParam, CryptoSpec } from "./crypto"

/** `bigEndian` is the CRC's wire byte order. */
interface CrcSpec extends CryptoSpec
{
    readonly bigEndian: boolean
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
    const canonical = ALIAS_OF.get(alg)
    if(canonical !== undefined) throw new Error(`crypto: "${alg}" is an alias; name it by its catalogue entry, "${canonical}"`)
    if(alg !== "CRC" && !CANONICAL.has(alg)) throw new Error(`crypto: unknown algorithm "${alg}"`)
    const given = paramMap(alg, params)

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
        base = CANONICAL.get(alg)!
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

function reflect32(v: number, bits: number): number
{
    let r = 0
    for(let i = 0; i < bits; i++, v >>>= 1) r = (r << 1) | (v & 1)
    return r >>> 0
}

/** A 32-bit result's wire bytes. */
function bytes32(v: number, outLen: number, bigEndian: boolean): number[]
{
    const out: number[] = new Array(outLen)
    for(let i = 0; i < outLen; i++) out[bigEndian ? outLen - 1 - i : i] = (v >>> (8 * i)) & 0xff
    return out
}

function context(outLen: number, bigEndian: boolean, step: (b: number) => void, result: () => bigint): CryptoContext
{
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
            let v = result()
            const le: number[] = []
            for(let i = 0; i < outLen; i++, v >>= 8n) le.push(Number(v & 0xffn))
            return bigEndian ? le.reverse() : le
        },
    }
}

/** Table-driven Rocksoft model in 32-bit arithmetic. A register narrower
 *  than a byte runs left-aligned in 8 bits, unreflected. */
function crcSpec32(m: CrcModel): CrcSpec
{
    const table = new Uint32Array(256)
    const outLen = Math.ceil(m.width / 8)
    const xorout = Number(m.xorout)
    const { width, refout, bigEndian } = m

    if(m.refin)
    {
        const rpoly = reflect32(Number(m.poly), width)
        for(let i = 0; i < 256; i++)
        {
            let c = i
            for(let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ rpoly : c >>> 1
            table[i] = c
        }
        const init = reflect32(Number(m.init), width)
        return {
            outLen,
            bigEndian,
            create()
            {
                let reg = init
                let spent = false
                return {
                    outLen,
                    absorb(bytes, from, to)
                    {
                        if(spent) throw new Error(`crypto: ABSORB into a finished context`)
                        for(let i = from; i < to; i++) reg = (reg >>> 8) ^ table[(reg ^ (bytes[i] ?? 0)) & 0xff]!
                    },
                    final()
                    {
                        if(spent) throw new Error(`crypto: context finished twice`)
                        spent = true
                        return bytes32(((refout ? reg >>> 0 : reflect32(reg >>> 0, width)) ^ xorout) >>> 0, outLen, bigEndian)
                    },
                }
            },
        }
    }

    const w = Math.max(width, 8)
    const shift = w - width
    const hi = w - 8
    const top = 2 ** (w - 1)
    const mask = 2 ** w - 1
    const poly = (Number(m.poly) << shift) & mask
    for(let i = 0; i < 256; i++)
    {
        let c = i << hi
        for(let k = 0; k < 8; k++) c = ((c >>> 0) >= top) ? ((c << 1) ^ poly) & mask : (c << 1) & mask
        table[i] = c
    }
    const init = (Number(m.init) << shift) & mask
    return {
        outLen,
        bigEndian,
        create()
        {
            let reg = init
            let spent = false
            return {
                outLen,
                absorb(bytes, from, to)
                {
                    if(spent) throw new Error(`crypto: ABSORB into a finished context`)
                    for(let i = from; i < to; i++) reg = ((reg << 8) & mask) ^ table[((reg >>> hi) ^ (bytes[i] ?? 0)) & 0xff]!
                },
                final()
                {
                    if(spent) throw new Error(`crypto: context finished twice`)
                    spent = true
                    const crc = (reg >>> 0) >>> shift
                    return bytes32(((refout ? reflect32(crc, width) : crc) ^ xorout) >>> 0, outLen, bigEndian)
                },
            }
        },
    }
}

/** The same model over BigInt, for the widths 32 bits cannot hold. */
function crcSpecWide(m: CrcModel): CrcSpec
{
    const table: bigint[] = new Array(256)
    const outLen = Math.ceil(m.width / 8)
    const mask = (1n << BigInt(m.width)) - 1n

    if(m.refin)
    {
        const rpoly = reflect(m.poly, m.width)
        for(let i = 0; i < 256; i++)
        {
            let c = BigInt(i)
            for(let k = 0; k < 8; k++) c = (c & 1n) ? (c >> 1n) ^ rpoly : c >> 1n
            table[i] = c
        }
        const init = reflect(m.init, m.width)
        return {
            outLen,
            bigEndian: m.bigEndian,
            create()
            {
                let reg = init
                return context(outLen, m.bigEndian,
                    b => { reg = (reg >> 8n) ^ table[Number((reg ^ BigInt(b)) & 0xffn)]! },
                    () => (m.refout ? reg : reflect(reg, m.width)) ^ m.xorout)
            },
        }
    }

    const hi = BigInt(m.width - 8)
    const top = 1n << BigInt(m.width - 1)
    for(let i = 0; i < 256; i++)
    {
        let c = BigInt(i) << hi
        for(let k = 0; k < 8; k++) c = (c & top) ? ((c << 1n) ^ m.poly) & mask : (c << 1n) & mask
        table[i] = c
    }
    return {
        outLen,
        bigEndian: m.bigEndian,
        create()
        {
            let reg = m.init
            return context(outLen, m.bigEndian,
                b => { reg = ((reg << 8n) & mask) ^ table[Number(((reg >> hi) ^ BigInt(b)) & 0xffn)]! },
                () => (m.refout ? reflect(reg, m.width) : reg) ^ m.xorout)
        },
    }
}

/** `alg`'s spec under `params`: a catalogue name, or `"CRC"`. */
export function crcSpec(alg: string, params: readonly CryptoParam[]): CrcSpec
{
    const m = crcModel(alg, params)
    return m.width <= 32 ? crcSpec32(m) : crcSpecWide(m)
}

/** The integer CRC of `bytes` under `alg`, `xorout` applied — what a
 *  catalogue entry's `check` names. */
export function crcValue(alg: string, params: readonly CryptoParam[], bytes: ArrayLike<number>): bigint
{
    const spec = crcSpec(alg, params)
    const ctx = spec.create()
    ctx.absorb(bytes, 0, bytes.length)
    const out = ctx.final()
    return integerOf(spec.bigEndian ? out.reverse() : out)
}
