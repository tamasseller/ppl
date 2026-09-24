/**
 * Runtime tests for declared default values
 * (docs/reconciliation.md §2.4): `IntegerType.default`, `UnionType.defaultVariant`,
 * and `defaultValueOf`.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {bytes, defaultValueOf, i8, integer, list, named, nameOf, optional, struct, u8, union, unit} from "../../src/core/metamodel"
import {buildTypeGraph, child} from "../../src/core/type-graph"

////////////////////////////////////////////////////////////////////////////////////////////////
// integer: default is optional and must lie in min..max
////////////////////////////////////////////////////////////////////////////////////////////////

test("integer: default is absent when omitted", () => {
    assert.equal(integer(0, 255).default, undefined)
})

test("integer: the `default` option sets an explicit default", () => {
    assert.equal(integer(0, 255, {default: 7}).default, 7)
})

test("integer: a default outside min..max throws", () => {
    assert.throws(() => integer(10, 20, {default: 0}))
    assert.throws(() => integer(10, 20, {default: 21}))
    assert.equal(integer(10, 20, {default: 20}).default, 20)
})

test("integer: meaning is kept when given and absent otherwise", () => {
    assert.equal(integer(0, 4095, {meaning: "si:voltage"}).meaning, "si:voltage")
    assert.equal("meaning" in integer(0, 4095), false)
})

test("integer: a meaning must be namespaced", () => {
    assert.throws(() => integer(0, 4095, {meaning: "voltage"}))
    assert.throws(() => integer(0, 4095, {meaning: "si:"}))
    assert.throws(() => integer(0, 4095, {meaning: "si:volt age"}))
})

test("integer: shared range constants (u8/i8) declare no default", () => {
    assert.equal(u8.default, undefined)
    assert.equal(i8.default, undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// union: defaultVariant is opt-in and restricted to a unit-valued variant
////////////////////////////////////////////////////////////////////////////////////////////////

test("union: no defaultVariant by default", () => {
    assert.equal(union({ok: integer(0, 1), err: unit}).defaultVariant, undefined)
})

test("union: defaultVariant naming a unit variant is accepted", () => {
    const T = union({ok: integer(0, 1), unrecognized: unit}, {defaultVariant: "unrecognized"})
    assert.equal(T.defaultVariant, "unrecognized")
})

test("union: defaultVariant naming a non-existent variant throws", () => {
    assert.throws(() => union({ok: integer(0, 1), err: unit}, {defaultVariant: "missing"}))
})

test("union: defaultVariant naming a non-unit variant throws", () => {
    assert.throws(() => union({ok: integer(0, 1), err: unit}, {defaultVariant: "ok"}))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// optional: sugar for union({value: T, empty: unit}, {defaultVariant: "empty"})
////////////////////////////////////////////////////////////////////////////////////////////////

test("optional: exposes exactly the value/empty variants target rules match on", () => {
    const T = optional(u8)
    assert.deepEqual([...T.variants.keys()], ["value", "empty"])
    assert.equal(T.variants.get("value"), u8)
    assert.equal(T.variants.get("empty"), unit)
})

test("optional: \"empty\" is the declared defaultVariant, for free", () => {
    assert.equal(optional(u8).defaultVariant, "empty")
})

test("defaultValueOf: optional falls back to \"empty\" absent a real value", () => {
    assert.deepEqual(defaultValueOf(optional(u8)), {variant: "empty", value: undefined})
})

////////////////////////////////////////////////////////////////////////////////////////////////
// defaultValueOf: per-kind defaults
////////////////////////////////////////////////////////////////////////////////////////////////

test("defaultValueOf: unit is undefined", () => {
    assert.equal(defaultValueOf(unit), undefined)
})

test("defaultValueOf: integer is its own declared default", () => {
    assert.equal(defaultValueOf(integer(0, 255, {default: 42})), 42)
})

test("defaultValueOf: integer with no default throws", () => {
    assert.throws(() => defaultValueOf(integer(0, 255)))
    assert.throws(() => defaultValueOf(struct({a: integer(0, 255, {default: 1}), b: u8})))
})

test("defaultValueOf: list is always empty, regardless of element type", () => {
    assert.deepEqual(defaultValueOf(list(integer(0, 255))), [])
    assert.deepEqual(defaultValueOf(list(struct({a: integer(0, 255, {default: 5})}))), [])
})

test("defaultValueOf: struct composes its own fields' defaults recursively", () => {
    const T = struct({
        id: integer(0, 255, {default: 0}),
        quality: integer(0, 255, {default: 7}),
        nested: struct({flag: unit, count: integer(0, 100, {default: 3})}),
    })
    assert.deepEqual(defaultValueOf(T), {
        id: 0,
        quality: 7,
        nested: {flag: undefined, count: 3},
    })
})

test("defaultValueOf: union with a declared defaultVariant", () => {
    const T = union({temperature: integer(-40, 125), unrecognized: unit}, {defaultVariant: "unrecognized"})
    assert.deepEqual(defaultValueOf(T), {variant: "unrecognized", value: undefined})
})

test("defaultValueOf: union with no declared defaultVariant throws", () => {
    const T = union({temperature: integer(-40, 125), humidity: integer(0, 100)})
    assert.throws(() => defaultValueOf(T))
})

test("defaultValueOf: struct field of a union type with no default composes to a throw", () => {
    const NoDefault = union({temperature: integer(-40, 125), humidity: integer(0, 100)})
    const T = struct({id: integer(0, 255, {default: 0}), kind: NoDefault})
    assert.throws(() => defaultValueOf(T))
})

test("defaultValueOf: struct field of a union type WITH a default composes cleanly", () => {
    const WithDefault = union({temperature: integer(-40, 125), unrecognized: unit}, {defaultVariant: "unrecognized"})
    const T = struct({id: integer(0, 255, {default: 0}), kind: WithDefault})
    assert.deepEqual(defaultValueOf(T), {id: 0, kind: {variant: "unrecognized", value: undefined}})
})

test("defaultValueOf: follows reference thunks", () => {
    const T = () => integer(0, 255, {default: 9})
    assert.equal(defaultValueOf(T), 9)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// named() / nameOf()
////////////////////////////////////////////////////////////////////////////////////////////////

test("named() attaches a name readable via nameOf()", () => {
    const Ts = named("Timestamp", struct({secs: integer(0, 4294967295), nanos: integer(0, 999999999)}))
    assert.equal(nameOf(Ts), "Timestamp")
})

test("unnamed types have no name", () => {
    assert.equal(nameOf(struct({a: integer(0, 1)})), undefined)
})

test("a named thunk (recursive type) carries its name on the thunk itself", () => {
    const T = named("Tree", (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    }))

    assert.equal(nameOf(T), "Tree")
    // The struct/integer bodies reached through the thunk have no names.
    const g = buildTypeGraph(T)
    assert.equal(nameOf(child(g.root, {variant: "internal"})!.type), undefined)
    assert.equal(nameOf(child(g.root, {variant: "leaf"})!.type), undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// policies and length domains
////////////////////////////////////////////////////////////////////////////////////////////////

test("integer: an onOutOfDomain replacement must lie in min..max, in either direction", () => {
    assert.throws(() => integer(0, 10, {onOutOfDomain: {replace: 11}}))
    assert.throws(() => integer(0, 10, {onOutOfDomain: {encode: {replace: -1}}}))
    assert.deepEqual(integer(0, 10, {onOutOfDomain: {decode: "saturate"}}).onOutOfDomain, {decode: "saturate"})
})

test("list: minLength defaults to 0 and maxLength may not be below it", () => {
    assert.equal(list(u8).minLength, 0)
    assert.equal("maxLength" in list(u8), false)
    assert.throws(() => list(u8, {minLength: 5, maxLength: 4}))
    assert.throws(() => list(u8, {minLength: -1}))
})

test("bytes(n) is a fixed-length list of u8", () => {
    const b = bytes(6)
    assert.deepEqual([b.minLength, b.maxLength, b.elementType], [6, 6, u8])
})

test("union: an onUnknownVariant replacement must be one of its unit variants", () => {
    assert.throws(() => union({ok: u8, none: unit}, {onUnknownVariant: {replace: "missing"}}))
    assert.throws(() => union({ok: u8, none: unit}, {onUnknownVariant: {replace: "ok"}}))
    assert.deepEqual(union({ok: u8, none: unit}, {onUnknownVariant: {replace: "none"}}).onUnknownVariant, {replace: "none"})
})

