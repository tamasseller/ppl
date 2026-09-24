/**
 * Semantic Metamodel AST Definitions
 */

import { isIdentity } from "./transform"
import type { RoundingMode, Transform } from "./transform"

export const enum SemanticTypeKinds
{
    Unit     = "unit",
    Integer  = "integer",
    List     = "list",
    Struct   = "struct",
    Union    = "union"
}

export type SemanticType = UnitType | IntegerType | StructType | UnionType | ListType | (() => SemanticType)

/** A SemanticType with reference thunks deref'd — the form stored in a TypeNode. */
export type ConcreteSemanticType = UnitType | IntegerType | StructType | UnionType | ListType

export type SemanticField = {name: string; type: SemanticType}

/** One policy for both directions, or one per direction (docs/reconciliation.md §2.5). */
export type Policy<P> = P | {readonly decode?: P; readonly encode?: P}

export type OutOfDomainPolicy = "trap" | "saturate" | {readonly replace: number}
export type LengthPolicy = {readonly over?: "trap" | "truncate"; readonly under?: "trap" | "pad"}
export type UnknownVariantPolicy = "trap" | {readonly replace: string}
export type InexactPolicy = "trap" | RoundingMode

/** Both halves of a `Policy`, whichever form it was written in. */
export function policyHalves<P>(p: Policy<P> | undefined): {decode?: P; encode?: P}
{
    if(p === undefined) return {}
    if(typeof p === "object" && p !== null && ("decode" in p || "encode" in p))
        return p as {decode?: P; encode?: P}
    return {decode: p as P, encode: p as P}
}

export interface UnitType {kind: SemanticTypeKinds.Unit}
export const unit: UnitType = {kind: SemanticTypeKinds.Unit}

export interface IntegerType
{
    kind: SemanticTypeKinds.Integer
    min: number
    max: number
    /** Substituted when this slot exists on one side only
     *  (docs/reconciliation.md §2.4). Absent: the slot is required. */
    default?: number
    /** Namespaced, e.g. `si:voltage`. Compatibility is equality where both
     *  sides declare one (docs/reconciliation.md §2.1). */
    meaning?: string
    /** Absent: this numbering is the canonical one (docs/reconciliation.md §2.3). */
    toCanonical?: Transform
    onOutOfDomain?: Policy<OutOfDomainPolicy>
    onInexact?: Policy<InexactPolicy>
}

export interface ListType
{
    kind: SemanticTypeKinds.List
    elementType: SemanticType
    minLength: number
    /** Absent: unbounded. */
    maxLength?: number
    onLength?: Policy<LengthPolicy>
}

export interface StructType
{
    kind: SemanticTypeKinds.Struct
    fields: Map<string, SemanticType>
}

export interface UnionType
{
    kind: SemanticTypeKinds.Union
    variants: Map<string, SemanticType>
    /** The absent default (docs/reconciliation.md §2.4). Opt-in and
     *  restricted to a `unit`-valued variant, so it never needs a payload. */
    defaultVariant?: string
    onUnknownVariant?: Policy<UnknownVariantPolicy>
}

export const kindOf = (t: SemanticType): SemanticTypeKinds | "reference" => typeof t === "function" ? "reference" : t.kind

/** Follow reference thunks through to the concrete type they name — the
 *  same dereferencing `matchType`/`buildTypeGraph` each do internally,
 *  exposed here so any caller holding a possibly-thunk `SemanticType`
 *  (e.g. a child pulled off a match witness) can get its real kind/shape
 *  without re-deriving thunk-unwrapping itself. Recurses in case a thunk
 *  returns another thunk. */
export const derefType = (t: SemanticType): ConcreteSemanticType =>
    typeof t === "function" ? derefType(t()) : t

/** `kindOf`, but following reference thunks first — never returns
 *  `"reference"`. */
export const concreteKindOf = (t: SemanticType): SemanticTypeKinds => derefType(t).kind

export const isUnit = (t: SemanticType): t is UnitType => kindOf(t) === SemanticTypeKinds.Unit
export const isInteger = (t: SemanticType): t is IntegerType => kindOf(t) === SemanticTypeKinds.Integer
export const isList = (t: SemanticType): t is ListType => kindOf(t) === SemanticTypeKinds.List
export const isStruct = (t: SemanticType): t is StructType => kindOf(t) === SemanticTypeKinds.Struct
export const isUnion = (t: SemanticType): t is UnionType => kindOf(t) === SemanticTypeKinds.Union
export const isReference = (t: SemanticType): t is UnionType => kindOf(t) === "reference"

export interface IntegerOptions
{
    readonly default?: number
    readonly meaning?: string
    readonly toCanonical?: Transform
    readonly onOutOfDomain?: Policy<OutOfDomainPolicy>
    readonly onInexact?: Policy<InexactPolicy>
}

export const integer = (min: number, max: number, opts: IntegerOptions = {}): IntegerType =>
{
    if(min < -(2 ** 31) || max > 2 ** 32 - 1 || (min < 0 && max > 2 ** 31 - 1))
        throw new Error(`integer: ${min}..${max} fits neither 32-bit signed nor unsigned`)
    if(opts.default !== undefined && (opts.default < min || max < opts.default))
        throw new Error(`integer: default ${opts.default} is outside ${min}..${max}`)
    if(opts.meaning !== undefined && !/^[^\s:]+:\S+$/.test(opts.meaning))
        throw new Error(`integer: meaning "${opts.meaning}" is not namespaced, e.g. "si:voltage"`)
    for(const half of Object.values(policyHalves(opts.onOutOfDomain)))
        if(typeof half === "object" && (half.replace < min || max < half.replace))
            throw new Error(`integer: onOutOfDomain replacement ${half.replace} is outside ${min}..${max}`)
    const toCanonical = opts.toCanonical !== undefined && !isIdentity(opts.toCanonical) ? opts.toCanonical : undefined
    if(toCanonical !== undefined && opts.meaning === undefined)
        throw new Error("integer: toCanonical needs a meaning to say what the canonical numbering is")
    return {
        kind: SemanticTypeKinds.Integer, min, max, default: opts.default,
        ...(opts.meaning !== undefined && {meaning: opts.meaning}),
        ...(toCanonical !== undefined && {toCanonical}),
        ...(opts.onOutOfDomain !== undefined && {onOutOfDomain: opts.onOutOfDomain}),
        ...(opts.onInexact !== undefined && {onInexact: opts.onInexact}),
    }
}

// `2 ** n`, not `1 << n`: JS's `<<` operates on signed 32-bit ints (shift
// amount mod 32, result sign-interpreted), which silently breaks exactly
// at bits=32 — `1 << 32 === 1` (shift-by-32 wraps to shift-by-0), and
// `1 << 31` is already negative — giving `i32`/`u32` nonsense ranges
// (`u32` collapsed to `integer(0, 0)`). `2 ** n` is ordinary double
// arithmetic, correct for every width this is ever called with.
export const signedInteger = (bits: number): IntegerType => integer(-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
export const unsignedInteger = (bits: number): IntegerType => integer(0, 2 ** bits - 1)

export const i8 = signedInteger(8)
export const i16 = signedInteger(16)
export const i32 = signedInteger(32)

export const u8 = unsignedInteger(8)
export const u16 = unsignedInteger(16)
export const u32 = unsignedInteger(32)

export interface ListOptions
{
    readonly minLength?: number
    readonly maxLength?: number
    readonly onLength?: Policy<LengthPolicy>
}

export const list = (T: SemanticType, opts: ListOptions = {}): ListType =>
{
    const minLength = opts.minLength ?? 0
    if(!Number.isInteger(minLength) || minLength < 0)
        throw new Error(`list: minLength ${minLength} is not a non-negative integer`)
    if(opts.maxLength !== undefined && (!Number.isInteger(opts.maxLength) || opts.maxLength < minLength))
        throw new Error(`list: maxLength ${opts.maxLength} is below minLength ${minLength}`)
    return {
        kind: SemanticTypeKinds.List, elementType: T, minLength,
        ...(opts.maxLength !== undefined && {maxLength: opts.maxLength}),
        ...(opts.onLength !== undefined && {onLength: opts.onLength}),
    }
}

/** Fixed-length bytes, e.g. `bytes(6)` for a MAC address. */
export const bytes = (n: number): ListType => list(u8, {minLength: n, maxLength: n})

export const struct = (def: {[k: string]: SemanticType}): StructType =>
({
    kind: SemanticTypeKinds.Struct,
    fields: new Map(Object.entries(def))
})

export interface UnionOptions
{
    readonly defaultVariant?: string
    readonly onUnknownVariant?: Policy<UnknownVariantPolicy>
}

export const union = (def: {[k: string]: SemanticType}, opts: UnionOptions = {}): UnionType =>
{
    const requireUnitVariant = (name: string, what: string): void =>
    {
        const variantType = def[name]
        if(variantType === undefined)
            throw new Error(`union: ${what} "${name}" is not a variant of this union`)
        if(!isUnit(variantType))
            throw new Error(`union: ${what} "${name}" must be unit-valued`)
    }

    if(opts.defaultVariant !== undefined) requireUnitVariant(opts.defaultVariant, "defaultVariant")
    for(const half of Object.values(policyHalves(opts.onUnknownVariant)))
        if(typeof half === "object") requireUnitVariant(half.replace, "onUnknownVariant replacement")

    return {
        kind: SemanticTypeKinds.Union,
        variants: new Map(Object.entries(def)),
        defaultVariant: opts.defaultVariant,
        ...(opts.onUnknownVariant !== undefined && {onUnknownVariant: opts.onUnknownVariant}),
    }
}

/**
 * An optional value: sugar for the 2-variant `union({value: T, empty:
 * unit}, {defaultVariant: "empty"})` shape target/codec rules already recognize by exact
 * name (e.g. a C++ target's `std::optional<T>` rule,
 * `target-js`'s `T | null` rule) — one blessed constructor instead of each
 * schema author hand-rolling a union and hoping they used the same two
 * variant names those rules match on. `"empty"` is the declared
 * `defaultVariant` for free, so a field of this type added on one side
 * defaults to absent on the other (docs/reconciliation.md §2.4).
 */
export const optional = (T: SemanticType): UnionType => union({value: T, empty: unit}, {defaultVariant: "empty"})

/**
 * The value a decoder/encoder substitutes when a field/variant has no
 * source value of its own on one side of a reconciled pair of trees
 * (docs/reconciliation.md §4.4): `undefined` for `unit` (no data to
 * default), the type's own `default` for an integer, `[]` for a list
 * (an unfilled list is simply empty, never a declared value), the
 * field-by-field composition of its own fields' defaults for a struct,
 * and `{variant: defaultVariant, value: undefined}` for a union that
 * declared one.
 *
 * Throws if an integer with no `default`, or a union with no declared
 * `defaultVariant`, is reached — a type-tree author who never needs its default (e.g. it's never
 * the type of a field only one side of a reconciled pair declares) never
 * has to declare one; the failure only surfaces once this is actually
 * asked for, which docs/reconciliation.md §2.4 fixes as a build/codegen-time
 * error, not a per-message runtime trap.
 */
// — First-class type names ————————————————————————————————
//
// Replaces the old symbol-bag trait mechanism (`traits.ts`, removed):
// a name is definition-time metadata on the type object itself, read back
// by the same reference — no registry, no per-build extraction pass. Used
// for codegen labeling (`target-js`'s `nameOf`) and for
// `matcher.ts`'s `pNamed()` rule-matching. Deliberately a different
// namespace from a struct/union's field/variant names: those travel on
// the wire (docs/codec-image.md §3.3); a type's own name never does.

const NAME = Symbol("name")

/** Attach a name to a type object at definition time, e.g.
 *  `named("Timestamp", struct({secs: u32, nanos: u32}))`, or
 *  `named("Tree", (): any => union({...}))` for a recursive thunk. */
export const named = <T extends object>(name: string, obj: T): T =>
{
    (obj as {[NAME]?: string})[NAME] = name
    return obj
}

/** Read back a type's declared name, if any. */
export const nameOf = (t: SemanticType): string | undefined => (t as {[NAME]?: string})[NAME]

export function defaultValueOf(t: SemanticType, path?: string): unknown
{
    const at = path === undefined ? "" : ` at ${path}`
    const c = derefType(t)
    switch(c.kind)
    {
        case SemanticTypeKinds.Unit:    return undefined
        case SemanticTypeKinds.Integer:
            if(c.default === undefined)
                throw new Error(`defaultValueOf: integer${at} has no declared default`)
            return c.default
        case SemanticTypeKinds.List:    return []
        case SemanticTypeKinds.Struct:
            return Object.fromEntries([...c.fields.entries()].map(([name, type]) =>
                [name, defaultValueOf(type, path === undefined ? undefined : `${path}.${name}`)]))
        case SemanticTypeKinds.Union:
            if(c.defaultVariant === undefined)
                throw new Error(`defaultValueOf: union${at} has no declared defaultVariant`)
            return {variant: c.defaultVariant, value: undefined}
    }
}
