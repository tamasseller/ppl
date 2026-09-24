/**
 * src/target-js/test — Bridging a received codec image to a local schema
 * (engine/bridging-codec-module.ts, docs/reconciliation.md §4)
 *
 * Each test builds an "image" schema and a deliberately different "local"
 * schema, compiles the image's own program via `generateBridgingCodecModule`
 * against the local one, and checks the generated, compiled, *executed*
 * behavior against docs/reconciliation.md §4.4/§4.5's tables — not a
 * shape check on `Correspondence`/`Resolution` (that's
 * `procedure-types.test.ts`'s job, `codecs`), but proof the whole
 * chain (reconcile → resolve → codegen → real JS) produces the right
 * bytes/values/traps end to end.
 */
import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import type { SemanticType } from "../../src/core/index"
import { struct, union, unit, u8, u16, integer, named, buildTypeGraph, list, matchType } from "../../src/core/index"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, framedEncode, framedDecode, encodeCodecImage, decodeCodecImage } from "../../src/codecs/index"
import type { CodecImage } from "../../src/codecs/index"

import type { CodecTrap } from "../../src/target-js/runtime/codec-runtime"
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

function loadBridged(image: CodecImage, localType: SemanticType, name: string): { encode: (v: any) => Uint8Array; decode: (b: Uint8Array) => any; mod: any }
{
    const source = generateBridgingCodecModule({ name, image, localType })
    const mod = loadGenerated(source)
    return { encode: mod[`encode${name}`], decode: mod[`decode${name}`], mod }
}

describe("bridging: nothing to bridge — byte-identical to the ordinary (non-bridging) path", () =>
{
    test("identical struct schema round-trips exactly like generateCodecModule's own output", () =>
    {
        const T = named("Point", struct({ x: u8, y: u8 }))
        const image = imageOf(T)

        const bridged = loadBridged(image, T, "Point")
        const plainSource = generateCodecModule({ name: "Point", rootType: T, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram })
        const plain = loadGenerated(plainSource)

        const value = { x: 3, y: 250 }
        const bridgedBytes = bridged.encode(value)
        const plainBytes = plain.encodePoint(value)
        assert.deepEqual(Array.from(bridgedBytes), Array.from(plainBytes), "bridging-enabled codegen changed the wire bytes with nothing to bridge")
        assert.deepEqual(bridged.decode(bridgedBytes), plain.decodePoint(plainBytes))
        assert.deepEqual(bridged.decode(bridgedBytes), value)
    })
})

describe("bridging: struct, image-only field (§4.4)", () =>
{
    const Image = named("Widget", struct({ a: u8, extra: integer(0, 255, 42) }))
    const Local = named("Widget", struct({ a: u8 }))

    test("decode: the image-only field is dropped, cursor still lands correctly on the field after it", () =>
    {
        const image = imageOf(Image)
        const imagePlain = loadGenerated(generateCodecModule({ name: "Widget", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const bytes = imagePlain.encodeWidget({ a: 5, extra: 99 })

        const { decode } = loadBridged(image, Local, "Widget")
        assert.deepEqual(decode(bytes), { a: 5 })
    })

    test("encode: the wire still gets real bytes for the image-only field, substituted from the image's own declared default", () =>
    {
        const image = imageOf(Image)
        const { encode } = loadBridged(image, Local, "Widget")
        const bytes = encode({ a: 5 })

        const imagePlain = loadGenerated(generateCodecModule({ name: "Widget", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        assert.deepEqual(imagePlain.decodeWidget(bytes), { a: 5, extra: 42 })
    })
})

describe("bridging: struct, local-only field (§4.4)", () =>
{
    const Image = named("Widget", struct({ a: u8 }))
    const Local = named("Widget", struct({ a: u8, extra: integer(0, 255, 7) }))

    test("decode: the local-only field is seeded with its own declared default", () =>
    {
        const image = imageOf(Image)
        const imagePlain = loadGenerated(generateCodecModule({ name: "Widget", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const bytes = imagePlain.encodeWidget({ a: 5 })

        const { decode } = loadBridged(image, Local, "Widget")
        assert.deepEqual(decode(bytes), { a: 5, extra: 7 })
    })

    test("encode: the local-only field is silently dropped — wire bytes match encoding just the shared field", () =>
    {
        const image = imageOf(Image)
        const { encode } = loadBridged(image, Local, "Widget")
        const bytes = encode({ a: 5, extra: 99 })

        const imagePlain = loadGenerated(generateCodecModule({ name: "Widget", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const expectedBytes = imagePlain.encodeWidget({ a: 5 })
        assert.deepEqual(Array.from(bytes), Array.from(expectedBytes))
    })

    test("nested struct default: a local-only field whose own type is itself a struct gets a real, fully-composed default", () =>
    {
        const ImageNested = named("Nested", struct({ a: u8 }))
        const LocalNested = named("Nested", struct({
            a: u8,
            pos: named("Pos", struct({ x: integer(0, 255, 1), y: integer(0, 255, 2) })),
        }))

        const image = imageOf(ImageNested)
        const imagePlain = loadGenerated(generateCodecModule({ name: "Nested", rootType: ImageNested, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const bytes = imagePlain.encodeNested({ a: 9 })

        const { decode } = loadBridged(image, LocalNested, "Nested")
        assert.deepEqual(decode(bytes), { a: 9, pos: { x: 1, y: 2 } })
    })
})

describe("bridging: union, image-only variant (decode) / local-only variant (encode) (§4.5)", () =>
{
    const Image = named("Status", union({ ok: u8, err: u8 }))

    test("decode, local declares a default variant: an unrecognized tag materializes it", () =>
    {
        const Local = named("Status", union({ ok: u8, unknown: unit }, "unknown"))
        const image = imageOf(Image)
        const imagePlain = loadGenerated(generateCodecModule({ name: "Status", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const bytes = imagePlain.encodeStatus({ variant: "err", value: 7 })

        const { decode } = loadBridged(image, Local, "Status")
        assert.deepEqual(decode(bytes), { variant: "unknown", value: undefined })
    })

    test("decode, local declares no default variant: an unrecognized tag traps", () =>
    {
        const Local = named("Status", union({ ok: u8 }))
        const image = imageOf(Image)
        const imagePlain = loadGenerated(generateCodecModule({ name: "Status", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const bytes = imagePlain.encodeStatus({ variant: "err", value: 7 })

        const { decode } = loadBridged(image, Local, "Status")
        assert.throws(() => decode(bytes), /codec trap|isn't recognized locally/)
    })

    test("encode, local has an extra variant the image doesn't: encoding it traps", () =>
    {
        const Local = named("Status", union({ ok: u8, extra: u8 }))
        const image = imageOf(Image)
        const { encode } = loadBridged(image, Local, "Status")
        assert.throws(() => encode({ variant: "extra", value: 1 }), /isn't one of/)
    })

    test("encode, local is missing a variant the image has: the dead dispatch case still compiles and traps defensively if ever reached", () =>
    {
        const Local = named("Status", union({ ok: u8 }))
        const image = imageOf(Image)
        const { encode } = loadBridged(image, Local, "Status")

        // The reachable path (the only one Local's own type can express)
        // still works normally — proves the dead "err" case alongside it
        // didn't break the switch it lives in.
        const bytes = encode({ variant: "ok", value: 5 })
        const imagePlain = loadGenerated(generateCodecModule({ name: "Status", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        assert.deepEqual(imagePlain.decodeStatus(bytes), { variant: "ok", value: 5 })

        // "err" is structurally unreachable through Local's own value type
        // (TS can't even name it) — bypass typing to actually land on the
        // dead case and confirm it's a defensive runtime trap, not a
        // crash or silently-wrong bytes.
        assert.throws(() => encode({ variant: "err", value: 7 } as any), /codec trap|unreachable/)
    })
})

describe("bridging: list of structs — per-element divergence propagates through CALL_CODEC_NEXT", () =>
{
    test("decode: each element's own image-only field is dropped, not just the list's own boundary", () =>
    {
        const Image = named("Container", struct({ items: list(named("Item", struct({ a: u8, extra: integer(0, 255, 9) }))) }))
        const Local = named("Container", struct({ items: list(named("Item", struct({ a: u8 }))) }))

        const image = imageOf(Image)
        const imagePlain = loadGenerated(generateCodecModule({ name: "Container", rootType: Image, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const bytes = imagePlain.encodeContainer({ items: [{ a: 1, extra: 11 }, { a: 2, extra: 22 }] })

        const { decode } = loadBridged(image, Local, "Container")
        assert.deepEqual(decode(bytes), { items: [{ a: 1 }, { a: 2 }] })
    })
})

describe("bridging: a CRC-framed image", () =>
{
    test("bridged codegen frames, verifies and traps exactly as the image's own codec does", () =>
    {
        const Image = named("Packet", struct({ id: u8, samples: list(u16) }))
        const Local = named("Packet", struct({ id: u8, samples: list(u16), extra: u8 }))
        const spec = { alg: "CRC-16/IBM-3740", code: 0x51 }
        const innerOf = (rules: typeof binaryEncodeRules) => rules.find(r => matchType(Image, r.pattern) !== undefined)!
        const image = decodeCodecImage(encodeCodecImage({
            typeTree: Image,
            encoderProgram: buildCodec(Image, [framedEncode(spec, innerOf(binaryEncodeRules), "Packet"), ...binaryEncodeRules], undefined),
            decoderProgram: buildCodec(Image, [framedDecode(spec, innerOf(binaryDecodeRules), "Packet"), ...binaryDecodeRules], undefined),
        }))

        const plain = loadGenerated(generateCodecModule({ name: "Packet", rootType: image.typeTree, encodeProgram: image.encoderProgram, decodeProgram: image.decoderProgram }))
        const bridged = loadBridged(image, Local, "Packet")

        const bytes = bridged.encode({ id: 7, samples: [1, 2, 3], extra: 9 })
        assert.deepEqual(Array.from(bytes), Array.from(plain.encodePacket({ id: 7, samples: [1, 2, 3] })), "the local-only field leaked onto the wire, or the frame differs")
        assert.deepEqual(bridged.decode(bytes), { id: 7, samples: [1, 2, 3], extra: 0 })

        const bad = Uint8Array.from(bytes)
        bad[3]! ^= 1
        assert.throws(() => bridged.decode(bad), (e: unknown) => e instanceof Error && e.name === "CodecTrap" && (e as CodecTrap).code === 0x51)
    })
})
