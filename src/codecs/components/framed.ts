/**
 * codecs — A CRC frame around another rule's body (the workspace's
 * docs/crypto.md §1.1)
 *
 * Wire detail beneath the codec mapping: the schema never names the CRC.
 * Wire layout `[crc][body]`, the CRC covering the rest of the stream, so a
 * frame is the last thing its stream carries. Decode verifies before it
 * reads a byte of the body and traps with `code` on a mismatch, which is
 * the frame's only observable behaviour.
 *
 * Wraps `inner`'s fragment rather than delegating to its procedure:
 * `CALL_CODEC` binds only a child, so a frame cannot hand its own `o0` on.
 */

import { ir } from "mog-core"
import type { NamedMatch, TypeMatch, TypePattern } from "../../core/index"
import { pNamed } from "../../core/index"
import type { CodecRule } from "../engine/resolver"
import type { CryptoParam } from "../engine/crypto"
import { cryptoSpec, integerParamBytes } from "../engine/crypto"

export interface FrameSpec
{
    /** A RevEng catalogue name, or `"CRC"` with the six Rocksoft parameters. */
    readonly alg: string
    /** Integers or byte strings, e.g. `{byteorder: 1}`. */
    readonly params?: Readonly<Record<string, number | readonly number[]>>
    /** The `TRAP` code a decode-side mismatch raises. */
    readonly code: number
}

const irString = (s: string): string => `"${s.replace(/[\\"]/g, c => `\\${c}`)}"`

const irBytes = (b: readonly number[]): string =>
    `x"${b.map(v => v.toString(16).padStart(2, "0")).join("")}"`

function initArgs(spec: FrameSpec): string
{
    const pairs = Object.entries(spec.params ?? {}).map(([name, v]) =>
        `, ${irString(name)}, ${typeof v === "number" ? String(v) : irBytes(v)}`)
    return `${irString(spec.alg)}${pairs.join("")}`
}

/** The CRC's wire length; also rejects an unimplemented `spec` at build time. */
function outLenOf(spec: FrameSpec): number
{
    const params: CryptoParam[] = Object.entries(spec.params ?? {}).map(([name, v]) =>
        ({ name, value: typeof v === "number" ? integerParamBytes(v) : v }))
    return cryptoSpec(spec.alg, params).outLen
}

const patternOf = (inner: CodecRule<unknown>, name: string | undefined): TypePattern =>
    name === undefined ? inner.pattern : pNamed(name, inner.pattern)

const innerMatchOf = (match: TypeMatch, name: string | undefined): TypeMatch =>
    name === undefined ? match : (match as NamedMatch).innerMatch as TypeMatch

/** A placeholder, the body through `i0`, then the CRC written back into the
 *  placeholder through a parked fork. With `name`, applies only to the type
 *  declared under that name. */
export function framedEncode<Ctx>(spec: FrameSpec, inner: CodecRule<Ctx>, name?: string): CodecRule<Ctx>
{
    const outLen = outLenOf(spec)
    return {
        pattern: patternOf(inner as CodecRule<unknown>, name),
        produce: (match, ctx, resolve, scope) =>
        {
            const tag = scope.iter()
            const body = scope.iter()
            const c = scope.crypto()
            return ir`
                clone_wr(${scope.i0}, ${tag});
                ${Array.from({ length: outLen }, () => `write(${scope.i0}, 1, 0);`).join(" ")}
                clone_rd(${scope.i0}, ${body});
                crypto_init(${c}, ${initArgs(spec)});
                ${inner.produce(innerMatchOf(match, name), ctx, resolve, scope)}
                absorb(${c}, ${body}, ${scope.i0});
                final(${c}, ${tag});`
        },
    }
}

/** The rest of the stream checked against the leading CRC, then the body
 *  decoded; a mismatch traps with `spec.code` before the body is read. */
export function framedDecode<Ctx>(spec: FrameSpec, inner: CodecRule<Ctx>, name?: string): CodecRule<Ctx>
{
    const outLen = outLenOf(spec)
    return {
        pattern: patternOf(inner as CodecRule<unknown>, name),
        produce: (match, ctx, resolve, scope) =>
        {
            const body = scope.iter()
            const c = scope.crypto()
            return ir`
                clone_rd(${scope.i0}, ${body});
                seek(${body}, ${outLen});
                crypto_init(${c}, ${initArgs(spec)});
                absorb_rest(${c}, ${body});
                verify(${c}, ${scope.i0}, ${spec.code});
                ${inner.produce(innerMatchOf(match, name), ctx, resolve, scope)}`
        },
    }
}
