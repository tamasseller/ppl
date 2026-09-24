/**
 * codecs — A CRC frame around another rule's body (the workspace's
 * docs/crypto.md §1.1)
 *
 * Wire detail beneath the codec mapping: the schema never names the CRC.
 * Encode appends it after the body; decode checks it and traps with
 * `code` on a mismatch, which is the frame's only observable behaviour.
 *
 * Wraps `inner`'s fragment rather than delegating to its procedure:
 * `CALL_CODEC` binds only a child, so a frame cannot hand its own `o0` on.
 */

import type { IrFragment } from "mog-core"
import { ir } from "mog-core"
import type { NamedMatch, TypeMatch } from "../../core/index"
import { pNamed } from "../../core/index"
import type { CodecRule } from "../engine/resolver"
import type { CodecScope, CryptoId } from "../engine/scope"

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

function frame<Ctx>(
    spec: FrameSpec,
    inner: CodecRule<Ctx>,
    name: string | undefined,
    close: (c: CryptoId, scope: CodecScope) => IrFragment,
): CodecRule<Ctx>
{
    return {
        pattern: name === undefined ? inner.pattern : pNamed(name, inner.pattern),
        produce: (match, ctx, resolve, scope) =>
        {
            const innerMatch = name === undefined ? match : (match as NamedMatch).innerMatch as TypeMatch
            const start = scope.iter()
            const c = scope.crypto()
            return ir`
                clone_rd(${scope.i0}, ${start});
                crypto_init(${c}, ${initArgs(spec)});
                ${inner.produce(innerMatch, ctx, resolve, scope)}
                absorb(${c}, ${start}, ${scope.i0});
                ${close(c, scope)}`
        },
    }
}

/** `inner`'s encoding followed by its CRC. With `name`, applies only to
 *  the type declared under that name. */
export function framedEncode<Ctx>(spec: FrameSpec, inner: CodecRule<Ctx>, name?: string): CodecRule<Ctx>
{
    return frame(spec, inner, name, (c, scope) => ir`final(${c}, ${scope.i0});`)
}

/** `inner`'s decoding, then its CRC checked; a mismatch traps with `spec.code`. */
export function framedDecode<Ctx>(spec: FrameSpec, inner: CodecRule<Ctx>, name?: string): CodecRule<Ctx>
{
    return frame(spec, inner, name, (c, scope) => ir`verify(${c}, ${scope.i0}, ${spec.code});`)
}
