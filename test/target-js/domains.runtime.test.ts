/**
 * src/target-js/test — Domains, policies and validation in generated code
 * (docs/reconciliation.md §4.6, §4.7, §5)
 *
 * Every test compiles and runs real generated code: an ordinary module for
 * validation, a bridged one (`generateBridgingCodecModule`) for policies.
 * Lists of integers take the bulk-transfer path, lists of structs the
 * per-element one, so both are exercised.
 */
import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import { ir } from "mog-core"
import type { SemanticType } from "../../src/core/index"
import { struct, u8, u16, integer, named, list, bytes, pStruct, pList, pInteger } from "../../src/core/index"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, codecRule } from "../../src/codecs/index"
import type { CodecImage } from "../../src/codecs/index"

import { generateBridgingCodecModule } from "../../src/target-js/engine/bridging-codec-module"
import { generateCodecModule } from "../../src/target-js/engine/codec-module"
import { loadGenerated } from "./load-generated"

function imageOf(rootType: SemanticType): CodecImage
{
    return {
        typeTree: rootType,
        encoderProgram: buildCodec(rootType, binaryEncodeRules, undefined),
        decoderProgram: buildCodec(rootType, binaryDecodeRules, undefined),
    }
}

type Codec = { encode: (v: any) => Uint8Array; decode: (b: Uint8Array) => any }

function plain(rootType: SemanticType): Codec
{
    const image = imageOf(rootType)
    const mod = loadGenerated(generateCodecModule({ name: "T", rootType, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
    return { encode: mod.encodeT, decode: mod.decodeT }
}

function bridged(imageType: SemanticType, localType: SemanticType): Codec
{
    const mod = loadGenerated(generateBridgingCodecModule({ name: "T", image: imageOf(imageType), localType }))
    return { encode: mod.encodeT, decode: mod.decodeT }
}

describe("validation (§5.2): ordinary generated code", () =>
{
    const T = named("T", struct({ v: integer(0, 100) }))

    test("decode: a value outside the image's range is malformed", () =>
    {
        assert.deepEqual(plain(T).decode(Uint8Array.from([100])), { v: 100 })
        assert.throws(() => plain(T).decode(Uint8Array.from([200])), /malformed value at T\.v: 200 is outside 0\.\.100/)
    })

    test("encode: an application value outside its own range is invalid", () =>
    {
        assert.throws(() => plain(T).encode({ v: 101 }), /invalid value at T\.v: 101 is outside 0\.\.100/)
        assert.throws(() => plain(T).encode({ v: NaN }), /invalid value at T\.v/)
    })

    test("a range away from zero round-trips its raw values", () =>
    {
        const R = named("T", struct({ a: integer(1000, 1100), b: integer(-200, 50), l: list(integer(1000, 1100)) }))
        const v = { a: 1050, b: -200, l: [1000, 1100] }
        assert.deepEqual(plain(R).decode(plain(R).encode(v)), v)
    })

    test("a list's length is validated both ways", () =>
    {
        const L = named("T", struct({ l: list(u8, { maxLength: 3 }) }))
        assert.throws(() => plain(L).encode({ l: [1, 2, 3, 4] }), /invalid length at T\.l: 4 is outside 0\.\.3/)
        assert.throws(() => plain(L).decode(Uint8Array.from([4, 1, 2, 3, 4])), /malformed length at .*: 4 is outside 0\.\.3/)
        assert.deepEqual(plain(L).decode(plain(L).encode({ l: [1, 2, 3] })), { l: [1, 2, 3] })
    })

    test("list elements are validated on the bulk path", () =>
    {
        const L = named("T", list(integer(0, 9)))
        assert.throws(() => plain(L).encode([1, 10]), /invalid value at .*\[\]: 10 is outside 0\.\.9/)
        assert.throws(() => plain(L).decode(Uint8Array.from([2, 1, 10])), /malformed value at .*\[\]: 10 is outside 0\.\.9/)
    })

    test("a fixed-length list round-trips and rejects any other length", () =>
    {
        const Mac = named("T", struct({ mac: bytes(6) }))
        const mac = [1, 2, 3, 4, 5, 6]
        assert.deepEqual(plain(Mac).decode(plain(Mac).encode({ mac })), { mac })
        assert.throws(() => plain(Mac).encode({ mac: [1, 2] }), /invalid length at T\.mac/)
    })
})

describe("integer domains (§4.6): bridged", () =>
{
    const Wide = named("T", struct({ v: u16 }))
    const narrow = (onOutOfDomain: any) => named("T", struct({ v: integer(0, 255, { onOutOfDomain }) }))

    test("decode, saturate", () =>
    {
        const { decode } = bridged(Wide, narrow("saturate"))
        assert.deepEqual(decode(plain(Wide).encode({ v: 300 })), { v: 255 })
        assert.deepEqual(decode(plain(Wide).encode({ v: 7 })), { v: 7 })
    })

    test("decode, replace", () =>
    {
        const { decode } = bridged(Wide, narrow({ replace: 0 }))
        assert.deepEqual(decode(plain(Wide).encode({ v: 300 })), { v: 0 })
    })

    test("decode, trap names the position", () =>
    {
        const { decode } = bridged(Wide, narrow("trap"))
        assert.throws(() => decode(plain(Wide).encode({ v: 300 })), /out of domain at T\.v: 300 is outside 0\.\.255/)
    })

    test("encode: a local range wider than the image's needs its own policy", () =>
    {
        const Narrow = named("T", struct({ v: u8 }))
        const local = named("T", struct({ v: integer(0, 1000, { onOutOfDomain: "saturate" }) }))
        const { encode } = bridged(Narrow, local)
        assert.deepEqual(plain(Narrow).decode(encode({ v: 900 })), { v: 255 })
    })

    test("no policy for a partial edge fails codegen, naming the position", () =>
    {
        assert.throws(() => bridged(Wide, named("T", struct({ v: u8 }))), /decode at T\.v can see values outside 0\.\.255/)
    })
})

describe("list lengths (§4.7): bridged", () =>
{
    const Item = struct({ a: u8 })
    const shapes = [
        { name: "bulk (list of integers)", element: u8, value: (n: number) => Array.from({ length: n }, (_, i) => i + 1) },
        { name: "per-element (list of structs)", element: Item, value: (n: number) => Array.from({ length: n }, (_, i) => ({ a: i + 1 })) },
    ]

    for(const { name, element, value } of shapes)
    {
        test(`${name}: decode, truncate keeps the first maxLength and stays aligned`, () =>
        {
            const Image = named("T", struct({ l: list(element, { maxLength: 8 }), tail: integer(0, 255) }))
            const Local = named("T", struct({ l: list(element, { maxLength: 4, onLength: { over: "truncate" } }), tail: integer(0, 255) }))
            const bytesIn = plain(Image).encode({ l: value(6), tail: 99 })
            assert.deepEqual(bridged(Image, Local).decode(bytesIn), { l: value(4), tail: 99 })
        })

        test(`${name}: decode, over trap`, () =>
        {
            const Image = named("T", struct({ l: list(element, { maxLength: 8 }) }))
            const Local = named("T", struct({ l: list(element, { maxLength: 4, onLength: { over: "trap" } }) }))
            assert.throws(() => bridged(Image, Local).decode(plain(Image).encode({ l: value(6) })), /too long at T\.l: 6 is outside 0\.\.4/)
        })

        test(`${name}: encode, truncate sends the first maxLength`, () =>
        {
            const Image = named("T", struct({ l: list(element, { maxLength: 4 }) }))
            const Local = named("T", struct({ l: list(element, { maxLength: 8, onLength: { over: "truncate" } }) }))
            assert.deepEqual(plain(Image).decode(bridged(Image, Local).encode({ l: value(6) })), { l: value(4) })
        })
    }

    test("decode, pad fills with the local element's default", () =>
    {
        const Image = named("T", struct({ l: list(u8, { maxLength: 4 }) }))
        const Local = named("T", struct({ l: list(integer(0, 255, { default: 9 }), { minLength: 3, maxLength: 4, onLength: { under: "pad" } }) }))
        assert.deepEqual(bridged(Image, Local).decode(plain(Image).encode({ l: [1] })), { l: [1, 9, 9] })
    })

    test("decode, pad on the per-element path builds a fresh default per element", () =>
    {
        const Image = named("T", struct({ l: list(struct({ a: u8 }), { maxLength: 4 }) }))
        const Local = named("T", struct({ l: list(struct({ a: integer(0, 255, { default: 5 }) }), { minLength: 2, maxLength: 4, onLength: { under: "pad" } }) }))
        const out = bridged(Image, Local).decode(plain(Image).encode({ l: [] }))
        assert.deepEqual(out, { l: [{ a: 5 }, { a: 5 }] })
        assert.notEqual(out.l[0], out.l[1])
    })

    test("encode, pad sends the local element's default past the real length", () =>
    {
        const Image = named("T", struct({ l: list(u8, { minLength: 3, maxLength: 4 }) }))
        const Local = named("T", struct({ l: list(integer(0, 255, { default: 7 }), { maxLength: 4, onLength: { under: "pad" } }) }))
        assert.deepEqual(plain(Image).decode(bridged(Image, Local).encode({ l: [1] })), { l: [1, 7, 7] })
    })

    test("decode, under trap", () =>
    {
        const Image = named("T", struct({ l: list(u8, { maxLength: 4 }) }))
        const Local = named("T", struct({ l: list(u8, { minLength: 2, maxLength: 4, onLength: { under: "trap" } }) }))
        assert.throws(() => bridged(Image, Local).decode(plain(Image).encode({ l: [1] })), /too short at T\.l: 1 is outside 2\.\.Infinity/)
    })

    test("element checks turn a bulk transfer into a checked per-element loop", () =>
    {
        const Image = named("T", list(u16, { maxLength: 4 }))
        const Local = named("T", list(integer(0, 255, { onOutOfDomain: "saturate" }), { maxLength: 4 }))
        assert.deepEqual(bridged(Image, Local).decode(plain(Image).encode([1, 300, 2])), [1, 255, 2])
    })
})

describe("CLOSE_LIST: a list decoded inline, in its parent's procedure", () =>
{
    /** Decodes `struct({items: list(...)})` without a list procedure: the list
     *  is opened below slot 0. `close` false leaves out the close_list. */
    const inlineListDecode = (close: boolean) => codecRule(pStruct({ items: pList(pInteger(0, 255)) }), (_m, _ctx: void, _resolve, s) =>
    {
        const items = s.slot().enter(s.o0, 0)
        const elem = s.slot().enterNext(items)
        return ir`
            ${items.code}
            u32 left = 0;
            left = read(${s.i0}, 1);
            open_list(${items});
            while (left != 0) { ${elem.code} store_val(${elem}, read(${s.i0}, 1)); left = left - 1; }
            ${close ? ir`close_list(${items});` : ir``}
        `
    })

    const inline = (rootType: SemanticType, close = true): Codec =>
    {
        const mod = loadGenerated(generateCodecModule({
            name: "T", rootType,
            encodeProgram: buildCodec(rootType, binaryEncodeRules, undefined),
            decodeProgram: buildCodec(rootType, [inlineListDecode(close), ...binaryDecodeRules], undefined),
        }))
        return { encode: mod.encodeT, decode: mod.decodeT }
    }

    test("the list reaches its parent at the close", () =>
    {
        const T = named("T", struct({ items: list(u8) }))
        assert.deepEqual(inline(T).decode(Uint8Array.from([2, 7, 9])), { items: [7, 9] })
    })

    test("its length is checked at the close, below slot 0", () =>
    {
        const T = named("T", struct({ items: list(u8, { maxLength: 2 }) }))
        assert.throws(() => inline(T).decode(Uint8Array.from([3, 7, 9, 1])), /malformed length at T\.items: 3 is outside 0\.\.2/)
    })

    test("a list opened below slot 0 and never closed fails codegen", () =>
    {
        const T = named("T", struct({ items: list(u8) }))
        assert.throws(() => inline(T, false), /list at T\.items is opened but never closed/)
    })
})

