/**
 * src/core/test — Reconciliation (../src/reconcile.ts, docs/
 * reconciliation.md §4)
 *
 * Covers `reconcile()`'s structural walk (matched/image-only/local-only,
 * kind-mismatch rejection, cycle safety on either side, and the sibling-
 * sharing case that proves names live on the edge, not the node) and
 * `resolve()`'s direction-aware interpretation of it — all eight
 * cells of §4.4/§4.5's tables, including the two "unreachable" ones a union's
 * own selection mechanism rules out structurally.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { TypeNode } from "../../src/core/type-graph"
import type { SemanticType } from "../../src/core/metamodel"
import { buildTypeGraph } from "../../src/core/type-graph"
import { struct, union, unit, u8, u16, integer, list, named, defaultValueOf, bytes } from "../../src/core/metamodel"

import { affine, rational } from "../../src/core/transform"
import { reconcile, resolve, classify } from "../../src/core/reconcile"
import type { Correspondence, CorrespondenceEdge } from "../../src/core/reconcile"

const root = (t: Parameters<typeof buildTypeGraph>[0]): TypeNode => buildTypeGraph(t).root

function edgeOf(c: Correspondence, name: string): CorrespondenceEdge
{
    const e = c.children?.find(ch => ch.name === name)
    if(!e) throw new Error(`no child named "${name}"`)
    return e
}

describe("reconcile(): matched trees", () =>
{
    test("identical struct — every field matched", () =>
    {
        const image = root(struct({ a: u8, b: unit }))
        const local = root(struct({ a: u8, b: unit }))
        const c = reconcile(image, local)

        assert.equal(c.outcome, "matched")
        assert.equal(edgeOf(c, "a").correspondence.outcome, "matched")
        assert.equal(edgeOf(c, "b").correspondence.outcome, "matched")
    })

    test("matched list recurses into its one element edge", () =>
    {
        const image = root(list(u8))
        const local = root(list(u8))
        const c = reconcile(image, local)

        assert.equal(c.outcome, "matched")
        assert.equal(c.element?.outcome, "matched")
    })

    test("matched union — every variant matched", () =>
    {
        const image = root(union({ on: unit, off: unit }))
        const local = root(union({ on: unit, off: unit }))
        const c = reconcile(image, local)

        assert.equal(edgeOf(c, "on").correspondence.outcome, "matched")
        assert.equal(edgeOf(c, "off").correspondence.outcome, "matched")
    })
})

describe("reconcile(): kind mismatch is rejected (§4.3)", () =>
{
    test("an integer field becoming a struct throws", () =>
    {
        const image = root(struct({ a: u8 }))
        const local = root(struct({ a: struct({ x: u8 }) }))
        assert.throws(() => reconcile(image, local), /kind mismatch/)
    })

    test("root kind mismatch throws", () =>
    {
        assert.throws(() => reconcile(root(u8), root(unit)), /kind mismatch/)
    })
})

describe("reconcile(): struct field divergence", () =>
{
    test("a field only in the image is image-only", () =>
    {
        const image = root(struct({ a: u8, extra: u8 }))
        const local = root(struct({ a: u8 }))
        const c = reconcile(image, local)

        assert.equal(edgeOf(c, "a").correspondence.outcome, "matched")
        const extra = edgeOf(c, "extra").correspondence
        assert.equal(extra.outcome, "image-only")
        assert.equal(extra.localNode, undefined)
        assert.ok(extra.imageNode)
    })

    test("a field only in the local tree is local-only", () =>
    {
        const image = root(struct({ a: u8 }))
        const local = root(struct({ a: u8, extra: u8 }))
        const c = reconcile(image, local)

        const extra = edgeOf(c, "extra").correspondence
        assert.equal(extra.outcome, "local-only")
        assert.equal(extra.imageNode, undefined)
        assert.ok(extra.localNode)
    })

    test("an image-only subtree recurses entirely as image-only, not just its own top node", () =>
    {
        const image = root(struct({ nested: struct({ deep: u8 }) }))
        const local = root(struct({}))
        const c = reconcile(image, local)

        const nested = edgeOf(c, "nested").correspondence
        assert.equal(nested.outcome, "image-only")
        assert.equal(edgeOf(nested, "deep").correspondence.outcome, "image-only")
    })
})

describe("reconcile(): sibling positions sharing the same underlying type object", () =>
{
    test("two fields, both missing locally, both typed as the same shared constant, get distinct edges but the same shared node", () =>
    {
        // Names live on the edge, not the node (this file's own header) —
        // so sharing the target Correspondence across two positions is
        // correct, not a bug, as long as each position's own edge.name
        // is right.
        const image = root(struct({ first: u16, second: u16 }))
        const local = root(struct({}))
        const c = reconcile(image, local)

        const first = edgeOf(c, "first")
        const second = edgeOf(c, "second")
        assert.equal(first.name, "first")
        assert.equal(second.name, "second")
        assert.equal(first.correspondence, second.correspondence) // same shared Correspondence...
        assert.equal(first.correspondence.imageNode, second.correspondence.imageNode) // ...same shared TypeNode
    })
})

describe("reconcile(): cycle safety", () =>
{
    test("a local-only self-referential struct terminates, closing the loop back onto its own ancestor", () =>
    {
        const LocalNode: any = named("LocalNode", (): any => struct({ next: LocalNode, val: u8 }))
        const image = root(struct({}))
        const local = root(struct({ head: LocalNode }))
        const c = reconcile(image, local)

        const head = edgeOf(c, "head").correspondence
        assert.equal(head.outcome, "local-only")
        // `next` is the exact same (image=absent, local=LocalNode) pair as
        // `head` itself — a genuine cycle, so it's the same object, not an
        // infinite recursion.
        assert.equal(edgeOf(head, "next").correspondence, head)
        // A sibling, non-recursive field still gets its own, ordinary leaf.
        const val = edgeOf(head, "val").correspondence
        assert.equal(val.outcome, "local-only")
        assert.notEqual(val, head)
    })

    test("mutually-recursive image and local trees of the same shape reconcile without looping", () =>
    {
        const ImageNode: any = named("Node", (): any => union({ leaf: u8, branch: struct({ l: ImageNode, r: ImageNode }) }))
        const LocalNode: any = named("Node", (): any => union({ leaf: u8, branch: struct({ l: LocalNode, r: LocalNode }) }))
        const c = reconcile(root(ImageNode), root(LocalNode))

        assert.equal(c.outcome, "matched")
        const branch = edgeOf(c, "branch").correspondence
        assert.equal(branch.outcome, "matched")
        // `l`/`r` are the exact same (ImageNode, LocalNode) pair as the
        // root itself — the cycle closes back onto the root Correspondence
        // rather than recursing forever.
        assert.equal(edgeOf(branch, "l").correspondence, c)
        assert.equal(edgeOf(branch, "r").correspondence, c)
    })
})

describe("reconcile(): a mismatch names its position", () =>
{
    test("kind mismatch through a list and a union variant", () =>
    {
        const image = named("Packet", struct({ readings: list(union({ temp: struct({ v: u8 }), off: unit })) }))
        const local = named("Packet", struct({ readings: list(union({ temp: struct({ v: struct({}) }), off: unit })) }))
        assert.throws(() => reconcile(root(image), root(local)),
            { message: 'reconcile: kind mismatch at Packet.readings[].temp.v — image is "integer", local is "struct"' })
    })

    test("meaning mismatch; an unnamed root reads as root", () =>
    {
        const image = struct({ v: integer(0, 4095, { meaning: "si:voltage" }) })
        const local = struct({ v: integer(0, 4095, { meaning: "si:power" }) })
        assert.throws(() => reconcile(root(image), root(local)),
            { message: 'reconcile: meaning mismatch at root.v — image is "si:voltage", local is "si:power"' })
    })
})

describe("reconcile(): meaning (§4.3)", () =>
{
    const volts = integer(0, 4095, { meaning: "si:voltage" })
    const watts = integer(0, 4095, { meaning: "si:power" })

    test("different meanings are rejected", () =>
    {
        assert.throws(() => reconcile(root(struct({ v: volts })), root(struct({ v: watts }))), /meaning mismatch/)
    })

    test("equal meanings match", () =>
    {
        const c = reconcile(root(struct({ v: volts })), root(struct({ v: integer(0, 4095, { meaning: "si:voltage" }) })))
        assert.equal(edgeOf(c, "v").correspondence.outcome, "matched")
    })

    test("a meaning on one side only is compatible, either side", () =>
    {
        assert.equal(edgeOf(reconcile(root(struct({ v: volts })), root(struct({ v: u16 }))), "v").correspondence.outcome, "matched")
        assert.equal(edgeOf(reconcile(root(struct({ v: u16 })), root(struct({ v: volts }))), "v").correspondence.outcome, "matched")
    })
})

describe("resolve(): struct field — all four cells are real (§4.4 table)", () =>
{
    test("image-only field, decode → drop (§4.4)", () =>
    {
        const c = reconcile(root(struct({ extra: u8 })), root(struct({})))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "decode"), { action: "drop" })
    })

    test("image-only field, encode → default from the image (§4.4)", () =>
    {
        const c = reconcile(root(struct({ extra: integer(0, 255, {default: 7}) })), root(struct({})))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "encode"), { action: "default", value: 7 })
    })

    test("local-only field, decode → default from local (§4.4)", () =>
    {
        const c = reconcile(root(struct({})), root(struct({ extra: integer(0, 255, {default: 9}) })))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "decode"), { action: "default", value: 9 })
    })

    test("local-only field, encode → drop (§4.4)", () =>
    {
        const c = reconcile(root(struct({})), root(struct({ extra: u8 })))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "encode"), { action: "drop" })
    })

    test("a needed default that isn't declared throws, either side", () =>
    {
        const imageOnly = reconcile(root(struct({ extra: u8 })), root(struct({})))
        assert.throws(() => resolve(imageOnly, edgeOf(imageOnly, "extra"), "encode"), /no declared default/)
        const localOnly = reconcile(root(struct({})), root(struct({ extra: u8 })))
        assert.throws(() => resolve(localOnly, edgeOf(localOnly, "extra"), "decode"), /no declared default/)
    })

    test("a missing default names its position, below the edge that needs it", () =>
    {
        const c = reconcile(root(named("Packet", struct({ extra: struct({ a: integer(0, 255, { default: 1 }), b: u8 }) }))), root(struct({})))
        assert.throws(() => resolve(c, edgeOf(c, "extra"), "encode"),
            { message: "defaultValueOf: integer at Packet.extra.b has no declared default" })
    })

    test("matched field → bridge, both directions", () =>
    {
        const c = reconcile(root(struct({ a: u8 })), root(struct({ a: u8 })))
        assert.deepEqual(resolve(c, edgeOf(c, "a"), "encode"), { action: "bridge" })
        assert.deepEqual(resolve(c, edgeOf(c, "a"), "decode"), { action: "bridge" })
    })

    test("resolve throws if parent isn't matched", () =>
    {
        const image = root(struct({ nested: struct({ deep: u8 }) }))
        const local = root(struct({}))
        const c = reconcile(image, local)
        const nested = edgeOf(c, "nested").correspondence // itself image-only
        assert.throws(() => resolve(nested, edgeOf(nested, "deep"), "decode"), /parent must be a matched correspondence/)
    })
})

describe("resolve(): union variant — only two of four cells are reachable (§4.5 table)", () =>
{
    const tagOf = (image: SemanticType, local: SemanticType): Correspondence =>
        edgeOf(reconcile(root(struct({ tag: image })), root(struct({ tag: local }))), "tag").correspondence

    test("image-only variant, decode → the local onUnknownVariant, as a check", () =>
    {
        const tag = tagOf(union({ known: unit, extra: unit }), union({ known: unit }, { onUnknownVariant: { replace: "known" } }))
        assert.equal(edgeOf(tag, "extra").correspondence.outcome, "image-only")
        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "decode"),
            { action: "bridge", checks: [{ cause: "unknown-variant", policy: { replace: "known" } }] })
    })

    test("image-only variant, decode, trap policy → a trap check", () =>
    {
        const tag = tagOf(union({ known: unit, extra: unit }), union({ known: unit }, { onUnknownVariant: "trap" }))
        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "decode"),
            { action: "bridge", checks: [{ cause: "unknown-variant", policy: "trap" }] })
    })

    test("image-only variant, decode, no policy → build error naming the position", () =>
    {
        const tag = tagOf(union({ known: unit, extra: unit }), union({ known: unit }))
        assert.throws(() => resolve(tag, edgeOf(tag, "extra"), "decode"), /decode at root\.tag .* no onUnknownVariant/)
    })

    test("a defaultVariant is the absent default only, never an unknown-variant fallback", () =>
    {
        const tag = tagOf(union({ known: unit, extra: unit }), union({ known: unit, unrecognized: unit }, { defaultVariant: "unrecognized" }))
        assert.throws(() => resolve(tag, edgeOf(tag, "extra"), "decode"), /no onUnknownVariant/)
    })

    test("a replacement must be a variant of both sides", () =>
    {
        const tag = tagOf(union({ known: unit, extra: unit }), union({ known: unit, mine: unit }, { onUnknownVariant: { replace: "mine" } }))
        assert.throws(() => resolve(tag, edgeOf(tag, "extra"), "decode"), /replacement "mine" .* not a variant of both sides/)
    })

    test("image-only variant, encode → unreachable", () =>
    {
        const tag = tagOf(union({ known: unit, extra: unit }), union({ known: unit }))
        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "encode"), { action: "unreachable" })
    })

    test("local-only variant, encode → the local onUnknownVariant; none is a build error", () =>
    {
        const tag = tagOf(union({ known: unit }), union({ known: unit, extra: unit }, { onUnknownVariant: "trap" }))
        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "encode"),
            { action: "bridge", checks: [{ cause: "unknown-variant", policy: "trap" }] })
        const bare = tagOf(union({ known: unit }), union({ known: unit, extra: unit }))
        assert.throws(() => resolve(bare, edgeOf(bare, "extra"), "encode"), /encode at root\.tag .* no onUnknownVariant/)
    })

    test("local-only variant, decode → unreachable", () =>
    {
        const tag = tagOf(union({ known: unit }), union({ known: unit, extra: unit }))
        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "decode"), { action: "unreachable" })
    })

    test("matched variant → bridge, both directions", () =>
    {
        const tag = tagOf(union({ a: unit }), union({ a: unit }))
        assert.deepEqual(resolve(tag, edgeOf(tag, "a"), "encode"), { action: "bridge" })
        assert.deepEqual(resolve(tag, edgeOf(tag, "a"), "decode"), { action: "bridge" })
    })
})

describe("classify(): integer domains (§4.6)", () =>
{
    const leaf = (image: SemanticType, local: SemanticType): Correspondence =>
        edgeOf(reconcile(root(struct({ v: image })), root(struct({ v: local }))), "v").correspondence

    test("the destination contains the source → a bare bridge", () =>
    {
        assert.deepEqual(classify(leaf(u8, u16), "decode"), { action: "bridge" })
        assert.deepEqual(classify(leaf(u16, u8), "encode"), { action: "bridge" })
    })

    test("a wider source is partial and needs the local policy for that direction", () =>
    {
        assert.throws(() => classify(leaf(u16, u8), "decode"), /decode at root\.v can see values outside 0\.\.255 .* no onOutOfDomain/)
        assert.deepEqual(classify(leaf(u16, integer(0, 255, { onOutOfDomain: "saturate" })), "decode"),
            { action: "bridge", checks: [{ cause: "out-of-domain", domain: [0, 255], policy: "saturate" }] })
    })

    test("a per-direction policy covers only its own direction", () =>
    {
        const c = leaf(integer(0, 100), integer(50, 200, { onOutOfDomain: { decode: "trap" } }))
        assert.equal(classify(c, "decode").action, "bridge")
        assert.throws(() => classify(c, "encode"), /encode at root\.v .* no onOutOfDomain/)
    })

    test("an encode replacement must land in the image's range", () =>
    {
        const c = leaf(integer(0, 100), integer(0, 200, { onOutOfDomain: { replace: 150 } }))
        assert.throws(() => classify(c, "encode"), /replacement 150 at root\.v is outside the image's 0\.\.100/)
    })

    test("disjoint ranges are empty", () =>
    {
        assert.throws(() => classify(leaf(integer(0, 9), integer(10, 20)), "decode"), /no value fits both sides at root\.v/)
    })
})

describe("classify(): transforms (§4.6)", () =>
{
    const leaf = (image: SemanticType, local: SemanticType): Correspondence =>
        edgeOf(reconcile(root(struct({ v: image })), root(struct({ v: local }))), "v").correspondence
    const volts = (min: number, max: number, scale: [number, number], offset: number | [number, number], opts = {}) =>
        integer(min, max, { meaning: "si:voltage", toCanonical: affine(scale, offset), ...opts })

    test("ADC counts → millivolts: inexact, then out of domain", () =>
    {
        const adc = volts(0, 4095, [1, 2048], [5, 2])
        assert.throws(() => classify(leaf(adc, volts(2500, 4200, [1, 1000], 0)), "decode"),
            /decode at root\.v converts by 125\/256·x \+ 2500, which is inexact, .* no onInexact/)
        assert.throws(() => classify(leaf(adc, volts(2500, 4200, [1, 1000], 0, { onInexact: "nearest-even" })), "decode"),
            /can see values outside 2500\.\.4200 .* no onOutOfDomain/)
        assert.deepEqual(classify(leaf(adc, volts(2500, 4200, [1, 1000], 0, { onInexact: "nearest-even", onOutOfDomain: "saturate" })), "decode"), {
            action: "bridge",
            transform: { op: "affine", scale: rational(125n, 256n), offset: rational(2500n) },
            checks: [{ cause: "inexact", policy: "nearest-even" }, { cause: "out-of-domain", domain: [2500, 4200], policy: "saturate" }],
        })
    })

    test("deci-Celsius → millikelvin: total on decode, inexact on encode", () =>
    {
        const t = (min: number, max: number, scale: [number, number], offset: number | [number, number], opts = {}) =>
            integer(min, max, { meaning: "si:temperature", toCanonical: affine(scale, offset), ...opts })
        const c = leaf(t(-400, 1250, [1, 10], [5463, 20]), t(233150, 398150, [1, 1000], 0, { onInexact: { encode: "trap" } }))
        assert.deepEqual(classify(c, "decode"), { action: "bridge", transform: { op: "affine", scale: rational(100n), offset: rational(273150n) } })
        assert.deepEqual(classify(c, "encode"), {
            action: "bridge",
            transform: { op: "affine", scale: rational(1n, 100n), offset: rational(-5463n, 2n) },
            checks: [{ cause: "inexact", policy: "trap" }],
        })
    })

    test("binary angle measure → degrees × 1e7: inexact, within 2^53, in domain once rounded", () =>
    {
        const lon = (min: number, max: number, scale: [number, number], opts = {}) =>
            integer(min, max, { meaning: "geo:longitude", toCanonical: affine(scale), ...opts })
        const c = leaf(lon(-(2 ** 31), 2 ** 31 - 1, [45, 2 ** 29]), lon(-1800000000, 1800000000, [1, 10 ** 7], { onInexact: "nearest-even" }))
        assert.deepEqual(classify(c, "decode"), {
            action: "bridge",
            transform: { op: "affine", scale: rational(3515625n, 4194304n), offset: rational(0n) },
            checks: [{ cause: "inexact", policy: "nearest-even" }],
        })
    })

    test("NTP seconds → Unix seconds: exact, but pre-1970 is out of domain", () =>
    {
        const ntp = integer(0, 2 ** 32 - 1, { meaning: "time:utc-instant", toCanonical: affine(1, -2208988800) })
        assert.throws(() => classify(leaf(ntp, integer(0, 2 ** 32 - 1, { meaning: "time:utc-instant" })), "decode"),
            /can see values outside 0\.\.4294967295 .* no onOutOfDomain/)
        assert.deepEqual(classify(leaf(ntp, integer(0, 2 ** 32 - 1, { meaning: "time:utc-instant", onOutOfDomain: "trap" })), "decode"), {
            action: "bridge",
            transform: { op: "affine", scale: rational(1n), offset: rational(-2208988800n) },
            checks: [{ cause: "out-of-domain", domain: [0, 4294967295], policy: "trap" }],
        })
    })

    test("intermediates past 2^53 are a build error", () =>
    {
        const c = leaf(integer(0, 2 ** 32 - 1, { meaning: "x:y", toCanonical: affine(3000000) }), integer(0, 2 ** 32 - 1, { meaning: "x:y", onOutOfDomain: "saturate" }))
        assert.throws(() => classify(c, "decode"), /decode at root\.v converts by 3000000·x \+ 0, whose intermediates over 0\.\.4294967295 reach 12884901885000000, past 2\^53/)
    })

    test("an encode replacement is converted into the image's numbering, and must land exactly", () =>
    {
        const image = integer(0, 100, { meaning: "x:y", toCanonical: affine(10) })
        const local = (replace: number) => integer(0, 2000, { meaning: "x:y", onInexact: "floor", onOutOfDomain: { replace } })
        assert.deepEqual(classify(leaf(image, local(500)), "encode"), {
            action: "bridge",
            transform: { op: "affine", scale: rational(1n, 10n), offset: rational(0n) },
            checks: [{ cause: "inexact", policy: "floor" }, { cause: "out-of-domain", domain: [0, 100], policy: { replace: 50 } }],
        })
        assert.throws(() => classify(leaf(image, local(505)), "encode"), /replacement 505 at root\.v has no exact value in the image's numbering/)
    })

    test("a transform on the only side with a meaning has nothing to convert to", () =>
    {
        const volts = integer(0, 4095, { meaning: "si:voltage", toCanonical: affine([1, 2048]) })
        assert.throws(() => reconcile(root(struct({ v: volts })), root(struct({ v: integer(0, 4095) }))),
            /only the image side declares a meaning at root\.v, so its toCanonical has nothing to convert to/)
        assert.throws(() => reconcile(root(struct({ v: integer(0, 4095) })), root(struct({ v: volts }))), /only the local side/)
        assert.doesNotThrow(() => reconcile(root(struct({ v: integer(0, 4095, { meaning: "si:voltage" }) })), root(struct({ v: integer(0, 4095) }))))
    })
})

describe("classify(): list lengths (§4.7)", () =>
{
    const leaf = (image: SemanticType, local: SemanticType): Correspondence =>
        edgeOf(reconcile(root(struct({ l: image })), root(struct({ l: local }))), "l").correspondence

    test("a longer source needs onLength.over; a shorter one onLength.under", () =>
    {
        assert.throws(() => classify(leaf(list(u8, { maxLength: 8 }), list(u8, { maxLength: 4 })), "decode"), /more than 4 elements .* no onLength\.over/)
        assert.deepEqual(classify(leaf(list(u8, { maxLength: 8 }), list(u8, { maxLength: 4, onLength: { over: "truncate" } })), "decode"),
            { action: "bridge", checks: [{ cause: "over-length", maxLength: 4, policy: "truncate" }] })
        assert.throws(() => classify(leaf(list(u8), list(u8, { minLength: 2 })), "decode"), /fewer than 2 elements .* no onLength\.under/)
    })

    test("an unbounded source is longer than any bounded destination", () =>
    {
        assert.throws(() => classify(leaf(list(u8), list(u8, { maxLength: 4 })), "decode"), /no onLength\.over/)
    })

    test("pad needs the local element's default", () =>
    {
        assert.throws(() => classify(leaf(list(u8), list(u8, { minLength: 2, onLength: { under: "pad" } })), "decode"), /integer at root\.l\[\] has no declared default/)
    })

    test("disjoint fixed lengths are empty", () =>
    {
        assert.throws(() => classify(leaf(bytes(4), bytes(6)), "decode"), /no length fits both sides at root\.l/)
    })
})

