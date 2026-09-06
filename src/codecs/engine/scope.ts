/**
 * codecs — TS-side authoring carriers (docs/extension-surface.md §5)
 *
 * Resource ids a rule must not collide on come from here rather than from
 * hand-picked constants in fragment text. Every carrier is **pure**: it
 * yields ids and `enter` text, never emits an instruction as a side
 * effect, so DSL statement order stays a property of the template and not
 * of TS evaluation order (§5).
 *
 * One `CodecScope` per procedure, which is exactly the lifetime both
 * resources have: handle slots and stream forks are frame-scoped
 * (codec-extension.md §2.1/§2.2), ids restarting in every callee.
 *
 * Two names differ from the doc, each because the bare one is already
 * taken by something else in this package's public surface: `SlotHandle`
 * for the doc's `Handle` (codec-extension.ts's runtime object binding),
 * and `IterId` for its `Iter` (target-js's runtime iterator state).
 */

import type { IrFragment } from "mog-core"
import { ir } from "mog-core"
import type { TypeNode } from "../../core/index"
import { SemanticTypeKinds } from "../../core/index"

/** An allocated stream-iterator id. Splices as its number. */
export class IterId
{
    constructor(readonly id: number) {}
    toString(): string { return String(this.id) }
}

/** A slot, the type currently in it, and the `enter` that put it there. */
export interface SlotHandle
{
    readonly type: TypeNode
    readonly code: IrFragment
    toString(): string
}

/** An allocated object-handle slot. Untyped: a slot is reused across
 *  navigations of different types, which is why validate-handles.ts tracks
 *  handle types flow-sensitively rather than in a static table. */
export class Slot
{
    constructor(readonly id: number) {}

    toString(): string { return String(this.id) }

    /** Navigate `parent`'s child `ref` into this slot. Pure — computes the
     *  child type and the `enter` text, emits nothing by itself. */
    enter(parent: SlotHandle, ref: number): SlotHandle
    {
        const kind = parent.type.type.kind
        if(kind === SemanticTypeKinds.List)
            throw new Error("codec scope: list elements are reached via ENTER_NEXT, never by ref")
        if(kind !== SemanticTypeKinds.Struct && kind !== SemanticTypeKinds.Union)
            throw new Error(`codec scope: can't enter a ${kind} — struct/union only`)

        const edge = parent.type.edges[ref]
        if(!edge)
            throw new Error(`codec scope: ref ${ref} out of range (${parent.type.edges.length} field/variant(s) on this ${kind})`)

        return handleOf(this, edge.target, ir`enter(${this}, ${parent}, ${ref});`)
    }

    /** Navigate `parent`'s next element into this slot (codec-extension.md
     *  §3.4's sequential access). Unlike `enter`, what this returns is not
     *  idempotent: every execution advances the list cursor, so splice it
     *  once per element — a loop body's first statement, not a value
     *  re-spliced wherever the element is mentioned. */
    enterNext(parent: SlotHandle): SlotHandle
    {
        const kind = parent.type.type.kind
        if(kind !== SemanticTypeKinds.List)
            throw new Error(`codec scope: can't enter_next a ${kind} — list only`)

        const edge = parent.type.edges[0]
        if(!edge) throw new Error("codec scope: list type has no element edge")

        return handleOf(this, edge.target, ir`enter_next(${this}, ${parent});`)
    }
}

function handleOf(slot: Slot, type: TypeNode, code: IrFragment): SlotHandle
{
    return { type, code, toString: () => slot.toString() }
}

/** The ids and bindings one procedure's rule body may draw on. */
export interface CodecScope
{
    readonly o0: SlotHandle
    readonly i0: IterId
    slot(): Slot
    iter(): IterId
}

/** A scope for a procedure whose `o0` is bound to `entry` (§4's codec
 *  entry protocol). Ids go monotonic, with no block-scoped reclaim (§8). */
export function codecScope(entry: TypeNode): CodecScope
{
    let slots = 0
    let iters = 0

    return {
        o0: handleOf(new Slot(0), entry, ir``),
        i0: new IterId(0),
        slot: () => new Slot(++slots),
        iter: () => new IterId(++iters),
    }
}
