/**
 * core — Reconciliation (docs/reconciliation.md §4)
 *
 * Target- *and* codec-independent: this computes a mapping some codegen
 * consumes, but knows nothing about wire bytes, RTL, or any target
 * language — the same relationship `raise.ts` has to a target's own
 * emitter, just one layer further removed. Originally built in
 * `codecs` (where the problem motivating it, codec-image.md, lives)
 * but moved here once it was clear nothing in either function below
 * touches anything beyond `core`'s own `TypeNode`/`defaultValueOf` —
 * unlike `codecs`'s own `engine/resolver.ts` (`createCodecResolver`),
 * which genuinely can't move (it depends on `mog-core`'s `Procedure`/
 * `declareProc`/`lowerProgram`, and `core` stays `mog-core`-free
 * on purpose), reconciling two semantic type trees by name is exactly the
 * kind of pure, structural, metamodel-level operation `core` already
 * hosts elsewhere (`matchType`, `defaultValueOf`). `src/codecs/engine/
 * codec-extension.ts` re-exports `Direction` from here for its own
 * existing consumers — it isn't redefined there.
 *
 * Two functions, deliberately kept separate (docs/reconciliation.md §4.2
 * spells out why): `reconcile` is the direction-agnostic lock-step walk of
 * the image tree and the local tree (§4.2); `resolve` turns one edge of that
 * walk's result into what a codegen should actually do, which — unlike the
 * tree shape itself — does depend on direction (§4.4/§4.5's
 * tables).
 *
 * "Image tree" and "local tree" are both ordinary `TypeNode` graphs here —
 * the image side is whatever `buildTypeGraph` produces from a decoded
 * `codecs`-side `codec-image.ts`/`type-tree-wire.ts` type tree, the
 * local side is the consumer's own, independently-built graph. Nothing in
 * this file reads a value, a wire byte, or an opcode; it only walks the
 * two type shapes.
 *
 * Names live on the *edge*, never on the node — deliberately mirroring
 * `type-graph.ts`'s own `TypeEdge {step, target}` split (a `TypeNode` has
 * no name of its own; only the edge that reaches it does), for the exact
 * reason that document does it: the same `TypeNode` can be reached by
 * more than one edge (shared/deduped types, and — here specifically — a
 * genuine cycle closing back onto an ancestor still being processed).
 * `Correspondence` is memoized on the (imageNode, localNode) pair (`pair`
 * below), so a cyclic or shared position returns the exact same object a
 * caller already has elsewhere — invaluable for a codegen that wants to
 * monomorphize one generated procedure per distinct pair (`codecs`'s
 * own `createCodecResolver`/`declareProc`-cache pattern). An earlier draft
 * of this file instead put `.name`/`.parent` directly on `Correspondence`,
 * which silently broke exactly this sharing: a cyclic back-edge returned
 * the *ancestor's* name/parent instead of the edge's own. Keeping the node
 * itself purely structural (outcome + both `TypeNode`s + children/element)
 * avoids the bug entirely, rather than working around it.
 */

import type { TypeNode } from "./type-graph"
import { SemanticTypeKinds, defaultValueOf, nameOf, policyHalves } from "./metamodel"
import type { IntegerType, ListType, SemanticType, UnionType, Policy, OutOfDomainPolicy, UnknownVariantPolicy } from "./metamodel"

/** Which of the two ends of a codec a piece of generated/interpreted code
 *  is playing — encoding a local value onto the wire, or decoding wire
 *  bytes into one. A whole-program property in `codecs` (passed in
 *  once, read by `computeChild`'s union branch and `i0`'s own initial
 *  stream capability — see `codec-extension.ts`'s own doc comment) and, at
 *  a smaller grain here, `resolve`'s own per-edge parameter (§4.4/§4.5's
 *  tables are direction-crossed by construction). */
export type Direction = "encode" | "decode"

export type ReconciliationOutcome = "matched" | "image-only" | "local-only"

/**
 * One node of the reconciliation walk. Exactly one of `imageNode`/
 * `localNode` is absent when `outcome` isn't `"matched"` — never both
 * absent (a `Correspondence` always exists *because* at least one side
 * has this node). Purely structural — no name, no parent; see this file's
 * header for why.
 */
export interface Correspondence
{
    readonly outcome: ReconciliationOutcome
    readonly imageNode?: TypeNode
    readonly localNode?: TypeNode
    /** For error messages only: one position this pair occurs at. A shared
     *  pair is the same pair at every position, so any one names the defect. */
    readonly path: string
    /** Struct fields *or* union variants (never both — which one applies
     *  is determined by this node's own kind, whichever side has it),
     *  keyed by name. The *union* of names present on either side: image
     *  declaration order first (matching the wire's own `ref` addressing,
     *  §4.1), then any local-only names appended in local declaration
     *  order. Every name that exists on at least one side gets an entry,
     *  regardless of whether a codegen for a *specific* direction will
     *  actually need it — §4.5's table: a decode-side union switch only
     *  ever needs `"matched"`/`"image-only"` variants, an encode-side one
     *  only ever needs `"matched"`/`"local-only"` — filtering by outcome
     *  for the direction at hand is the caller's job, not `reconcile`'s. */
    readonly children?: readonly CorrespondenceEdge[]
    /** A list's one, unnamed element edge (§4.1: a list needs no name to
     *  match by at all) — present iff this node's kind is List. Always
     *  `"matched"` once its own kind check has passed: a `ListType`
     *  always has exactly one element edge on both sides, so there is no
     *  image-only/local-only *element* — only what's inside it can
     *  diverge. */
    readonly element?: Correspondence
}

export interface CorrespondenceEdge
{
    readonly name: string
    readonly correspondence: Correspondence
}

function fieldNamesOf(node: TypeNode | undefined): readonly string[]
{
    if(!node) return []
    return node.edges.filter(e => "field" in e.step).map(e => (e.step as { field: string }).field)
}

function variantNamesOf(node: TypeNode | undefined): readonly string[]
{
    if(!node) return []
    return node.edges.filter(e => "variant" in e.step).map(e => (e.step as { variant: string }).variant)
}

function fieldEdge(node: TypeNode | undefined, name: string): TypeNode | undefined
{
    return node?.edges.find(e => "field" in e.step && e.step.field === name)?.target
}

function variantEdge(node: TypeNode | undefined, name: string): TypeNode | undefined
{
    return node?.edges.find(e => "variant" in e.step && e.step.variant === name)?.target
}

function elementEdge(node: TypeNode | undefined): TypeNode | undefined
{
    return node?.edges.find(e => "element" in e.step)?.target
}

function unionOfNames(imageNames: readonly string[], localNames: readonly string[]): readonly string[]
{
    const extras = localNames.filter(n => !imageNames.includes(n))
    return [...imageNames, ...extras]
}

function outcomeOf(imageNode: TypeNode | undefined, localNode: TypeNode | undefined): ReconciliationOutcome
{
    return imageNode && localNode ? "matched" : imageNode ? "image-only" : "local-only"
}

/**
 * Reconcile `imageRoot` against `localRoot` (§4.2's lock-step walk).
 *
 * Memoized on the exact (imageNode, localNode) pair — mint the identity,
 * cache it, *then* recurse (mirroring `type-graph.ts`'s own `build()`
 * exactly: `byObject.set(key, node)` before `edgesOf`), so a self- or
 * mutually-recursive type on either side re-derives the same pair and
 * hits the cache instead of looping forever. Correct to share the cached
 * object across unrelated positions too — see this file's header — since a
 * `Correspondence` carries nothing position-dependent.
 *
 * Throws on a §4.3 kind mismatch — the one case reconciliation rejects
 * outright rather than resolving via §4.4/§4.5.
 */
export function reconcile(imageRoot: TypeNode, localRoot: TypeNode): Correspondence
{
    const cache = new Map<string, Correspondence>()

    // `path` names the first position reaching this pair; a memoized revisit reports nothing.
    function pair(imageNode: TypeNode | undefined, localNode: TypeNode | undefined, path: string): Correspondence
    {
        const key = `${imageNode?.id ?? "-"}|${localNode?.id ?? "-"}`
        const cached = cache.get(key)
        if(cached) return cached

        if(imageNode && localNode && imageNode.type.kind !== localNode.type.kind)
        {
            throw new Error(
                `reconcile: kind mismatch at ${path} — image is "${imageNode.type.kind}", local is "${localNode.type.kind}"`)
        }

        if(imageNode && localNode && imageNode.type.kind === SemanticTypeKinds.Integer)
        {
            const imageMeaning = (imageNode.type as IntegerType).meaning
            const localMeaning = (localNode.type as IntegerType).meaning
            if(imageMeaning !== undefined && localMeaning !== undefined && imageMeaning !== localMeaning)
            {
                throw new Error(
                    `reconcile: meaning mismatch at ${path} — image is "${imageMeaning}", local is "${localMeaning}"`)
            }
        }

        const outcome = outcomeOf(imageNode, localNode)
        const kind = (imageNode ?? localNode)!.type.kind
        const c: Correspondence = { outcome, imageNode, localNode, path }
        cache.set(key, c) // reserved — before recursing, so a cycle hits this entry

        if(kind === SemanticTypeKinds.Struct)
        {
            const names = unionOfNames(fieldNamesOf(imageNode), fieldNamesOf(localNode))
            const children = names.map(n => ({ name: n, correspondence: pair(fieldEdge(imageNode, n), fieldEdge(localNode, n), `${path}.${n}`) }))
            ;(c as { children?: readonly CorrespondenceEdge[] }).children = children
        }
        else if(kind === SemanticTypeKinds.Union)
        {
            const names = unionOfNames(variantNamesOf(imageNode), variantNamesOf(localNode))
            const children = names.map(n => ({ name: n, correspondence: pair(variantEdge(imageNode, n), variantEdge(localNode, n), `${path}.${n}`) }))
            ;(c as { children?: readonly CorrespondenceEdge[] }).children = children
        }
        else if(kind === SemanticTypeKinds.List)
        {
            const element = pair(elementEdge(imageNode), elementEdge(localNode), `${path}[]`)
            ;(c as { element?: Correspondence }).element = element
        }
        // Unit/Integer: leaves, nothing to recurse into.

        return c
    }

    return pair(imageRoot, localRoot, nameOf(imageRoot.source as SemanticType) ?? nameOf(localRoot.source as SemanticType) ?? "root")
}

export type Resolution =
    | { readonly action: "bridge"; readonly checks?: readonly Check[] }
    | { readonly action: "drop" }
    | { readonly action: "default"; readonly value: unknown }
    /** §4.5's table: a combination the union's own selection mechanism
     *  rules out. The instruction still exists, so it compiles to a throw. */
    | { readonly action: "unreachable" }

/** A per-value check a bridged edge needs, and the consumer's policy for
 *  a value that fails it (docs/reconciliation.md §2.5, §4.8). */
export type Check =
    | { readonly cause: "out-of-domain"; readonly domain: readonly [number, number]; readonly policy: OutOfDomainPolicy }
    | { readonly cause: "unknown-variant"; readonly policy: UnknownVariantPolicy }
    | { readonly cause: "over-length"; readonly maxLength: number; readonly policy: "trap" | "truncate" }
    | { readonly cause: "under-length"; readonly minLength: number; readonly policy: "trap" | "pad" }

export function policyFor<P>(p: Policy<P> | undefined, direction: Direction): P | undefined
{
    return policyHalves(p)[direction]
}

/**
 * Apply §4.4/§4.5's rules to one edge of `parent`'s children, for one
 * direction. `reconcile`'s own tree is direction-agnostic (§4.2) — this is
 * the separate, direction-aware interpretation step, called once per
 * direction a codegen is generating for, and once per edge it needs a
 * decision for (never recursively — see below).
 *
 * `parent` must itself be `"matched"`: once an edge resolves to anything
 * other than `"bridge"`, that resolution already describes the whole edge,
 * including whatever is nested inside it, so a caller never recurses into
 * a non-matched edge's own children.
 */
export function resolve(parent: Correspondence, edge: CorrespondenceEdge, direction: Direction): Resolution
{
    const c = edge.correspondence
    if(c.outcome === "matched") return { action: "bridge" }

    if(parent.outcome !== "matched")
        throw new Error("resolve: parent must be a matched correspondence — see this function's own doc comment")

    const parentKind = parent.imageNode!.type.kind

    if(parentKind === SemanticTypeKinds.Union)
    {
        // §4.5: an image-only variant only arrives on decode, a local-only
        // one is only ever encoded; the other two cells are unreachable.
        const reachable = c.outcome === "image-only" ? direction === "decode" : direction === "encode"
        if(!reachable) return { action: "unreachable" }
        return { action: "bridge", checks: [{ cause: "unknown-variant", policy: unknownVariantPolicy(parent, direction) }] }
    }

    // A struct field (parentKind === Struct; a List's "element" edge is
    // always "matched" and already returned above).
    if(c.outcome === "image-only")
    {
        // §4.4 (decode): dropping a struct field's write is unconditionally
        // safe. §4.4 (encode): substitute the field's own declared default,
        // read from the image — the only place a value for a field the
        // local model doesn't have at all could come from.
        return direction === "decode" ? { action: "drop" } : { action: "default", value: defaultValueOf(c.imageNode!.type, c.path) }
    }

    // local-only. §4.4 (decode): the decoder itself instantiates this
    // field's container; seed it from the local declared default. §4.4
    // (encode, additive): drop — unconditionally safe, the mirror of image-only/decode.
    return direction === "decode" ? { action: "default", value: defaultValueOf(c.localNode!.type, c.path) } : { action: "drop" }
}

/**
 * Classify one matched leaf-like position for one direction (§4.3): an
 * integer's range, a list's length, a union's variant set. `total` is a
 * bare `bridge`; `partial` carries the checks and the consumer's policies;
 * `empty`, or a partial edge with no policy for its cause, throws — a build
 * error, never a runtime trap. Needs no parent, so any slot can call it.
 */
export function classify(c: Correspondence, direction: Direction): Resolution
{
    if(c.outcome !== "matched")
        throw new Error(`classify: ${c.path} is ${c.outcome}, not matched`)

    const image = c.imageNode!.type
    const local = c.localNode!.type
    switch(image.kind)
    {
        case SemanticTypeKinds.Integer: return classifyInteger(c, image, local as IntegerType, direction)
        case SemanticTypeKinds.List: return classifyList(c, image, local as ListType, direction)
        case SemanticTypeKinds.Union:
        {
            const extra = (c.children ?? []).some(e => e.correspondence.outcome === (direction === "decode" ? "image-only" : "local-only"))
            return extra ? { action: "bridge", checks: [{ cause: "unknown-variant", policy: unknownVariantPolicy(c, direction) }] } : { action: "bridge" }
        }
        default: return { action: "bridge" }
    }
}

function classifyInteger(c: Correspondence, image: IntegerType, local: IntegerType, direction: Direction): Resolution
{
    const [src, dst] = direction === "decode" ? [image, local] : [local, image]
    if(dst.min <= src.min && src.max <= dst.max) return { action: "bridge" }
    if(src.max < dst.min || dst.max < src.min)
        throw new Error(`reconcile: no value fits both sides at ${c.path} — image is ${image.min}..${image.max}, local is ${local.min}..${local.max}`)

    const policy = policyFor(local.onOutOfDomain, direction)
    if(policy === undefined)
        throw new Error(`reconcile: ${direction} at ${c.path} can see values outside ${dst.min}..${dst.max} and the local integer declares no onOutOfDomain for it`)
    if(typeof policy === "object" && (policy.replace < dst.min || dst.max < policy.replace))
        throw new Error(`reconcile: onOutOfDomain replacement ${policy.replace} at ${c.path} is outside the image's ${dst.min}..${dst.max}`)

    return { action: "bridge", checks: [{ cause: "out-of-domain", domain: [dst.min, dst.max], policy }] }
}

function classifyList(c: Correspondence, image: ListType, local: ListType, direction: Direction): Resolution
{
    const [src, dst] = direction === "decode" ? [image, local] : [local, image]
    const bounds = (l: ListType): string => `${l.minLength}..${l.maxLength ?? ""}`
    if((src.maxLength !== undefined && src.maxLength < dst.minLength) || (dst.maxLength !== undefined && dst.maxLength < src.minLength))
        throw new Error(`reconcile: no length fits both sides at ${c.path} — image is ${bounds(image)}, local is ${bounds(local)}`)

    const policy = policyFor(local.onLength, direction) ?? {}
    const checks: Check[] = []

    if(dst.maxLength !== undefined && (src.maxLength === undefined || dst.maxLength < src.maxLength))
    {
        if(policy.over === undefined)
            throw new Error(`reconcile: ${direction} at ${c.path} can see more than ${dst.maxLength} elements and the local list declares no onLength.over for it`)
        checks.push({ cause: "over-length", maxLength: dst.maxLength, policy: policy.over })
    }

    if(src.minLength < dst.minLength)
    {
        if(policy.under === undefined)
            throw new Error(`reconcile: ${direction} at ${c.path} can see fewer than ${dst.minLength} elements and the local list declares no onLength.under for it`)
        if(policy.under === "pad") defaultValueOf(local.elementType, `${c.path}[]`)
        checks.push({ cause: "under-length", minLength: dst.minLength, policy: policy.under })
    }

    return checks.length === 0 ? { action: "bridge" } : { action: "bridge", checks }
}

function unknownVariantPolicy(c: Correspondence, direction: Direction): UnknownVariantPolicy
{
    const policy = policyFor((c.localNode!.type as UnionType).onUnknownVariant, direction)
    if(policy === undefined)
        throw new Error(`reconcile: ${direction} at ${c.path} can see a variant the other side lacks and the local union declares no onUnknownVariant for it`)
    if(typeof policy === "object")
    {
        const counterpart = (c.children ?? []).find(e => e.name === policy.replace)?.correspondence
        if(counterpart?.outcome !== "matched")
            throw new Error(`reconcile: onUnknownVariant replacement "${policy.replace}" at ${c.path} is not a variant of both sides`)
    }
    return policy
}
