/**
 * src/codecs/test — TS-side authoring carriers (engine/scope.ts,
 * docs/extension-surface.md §5/§6)
 *
 * The unit half checks allocation and `enter`'s type computation; the
 * end-to-end half rebuilds §6's worked changes as real rules and runs the
 * codecs they produce, which is the only way to prove the ids the carriers
 * hand out are the ones the fragments actually address.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, run, validateProgram } from "mog-core"
import { struct, union, list, u8, u16, unit, buildTypeGraph, derefType, SemanticTypeKinds, pStructFields, pStar, pInteger } from "../../src/core/index"
import { codecScope } from "../../src/codecs/engine/scope"
import { buildCodec, codecRule } from "../../src/codecs/engine/resolver"
import type { CodecRule } from "../../src/codecs/engine/resolver"
import { createCodecExtension } from "../../src/codecs/engine/codec-extension"
import { validateCodecHandles } from "../../src/codecs/engine/validate-handles"

const nodeOf = (t: Parameters<typeof buildTypeGraph>[0]) => buildTypeGraph(t).root

describe("codec scope — allocation", () =>
{
    test("o0 and i0 are the ids the calling convention binds, and splice as bare numbers", () =>
    {
        const s = codecScope(nodeOf(struct({ a: u8 })))
        assert.equal(`${s.o0}`, "0")
        assert.equal(`${s.i0}`, "0")
    })

    test("slot() and iter() go monotonic from 1, never colliding with o0/i0 or each other", () =>
    {
        const s = codecScope(nodeOf(struct({ a: u8 })))
        assert.deepEqual([`${s.slot()}`, `${s.slot()}`, `${s.slot()}`], ["1", "2", "3"])
        // The two spaces are independent — a slot never consumes an iterator id.
        assert.deepEqual([`${s.iter()}`, `${s.iter()}`], ["1", "2"])
    })

    test("each procedure's scope allocates independently — that is what makes ids collision-free per frame", () =>
    {
        const a = codecScope(nodeOf(struct({ a: u8 })))
        const b = codecScope(nodeOf(struct({ a: u8 })))
        a.slot(); a.slot()
        assert.equal(`${b.slot()}`, "1", "a second procedure restarts, rather than continuing a's numbering")
    })
})

describe("codec scope — enter", () =>
{
    test("computes the child type off the navigation, and emits the enter that put it there", () =>
    {
        const s = codecScope(nodeOf(struct({ first: u8, second: u16 })))
        const f = s.slot()
        const child = f.enter(s.o0, 1)

        assert.equal(`${child}`, "1", "the handle addresses the slot it was entered into")
        assert.equal(child.code.source.trim(), "enter(1, 0, 1);")
        const t = derefType(child.type.type) as { kind: string; min?: number; max?: number }
        assert.equal(t.kind, SemanticTypeKinds.Integer)
        assert.deepEqual({ min: t.min, max: t.max }, { min: 0, max: 65535 })
    })

    test("a union variant navigates by index just as a struct field does", () =>
    {
        const s = codecScope(nodeOf(union({ on: unit, off: u8 })))
        const child = s.slot().enter(s.o0, 1)
        assert.equal(derefType(child.type.type).kind, SemanticTypeKinds.Integer)
    })

    test("o0 carries no code of its own — nothing established it", () =>
    {
        const s = codecScope(nodeOf(struct({ a: u8 })))
        assert.equal(s.o0.code.source.trim(), "")
    })

    test("a handle can be re-entered from, building a path one level at a time", () =>
    {
        const s = codecScope(nodeOf(struct({ inner: struct({ deep: u8 }) })))
        const outer = s.slot().enter(s.o0, 0)
        const inner = s.slot().enter(outer, 0)
        assert.equal(inner.code.source.trim(), "enter(2, 1, 0);")
        assert.equal(derefType(inner.type.type).kind, SemanticTypeKinds.Integer)
    })

    test("rejects a list parent, an out-of-range ref, and a leaf parent", () =>
    {
        const listScope = codecScope(nodeOf(list(u8)))
        assert.throws(() => listScope.slot().enter(listScope.o0, 0), /ENTER_NEXT/)

        const s = codecScope(nodeOf(struct({ a: u8 })))
        assert.throws(() => s.slot().enter(s.o0, 3), /ref 3 out of range/)

        const leaf = codecScope(nodeOf(u8))
        assert.throws(() => leaf.slot().enter(leaf.o0, 0), /struct\/union only/)
    })

    test("carriers are pure — an enter that is never spliced contributes nothing", () =>
    {
        const s = codecScope(nodeOf(struct({ a: u8 })))
        const child = s.slot().enter(s.o0, 0)
        // Building the handle emitted no instruction; only the `${}` does.
        assert.equal(ir`write(${s.i0}, 1, 7);`.source.trim(), "write(0, 1, 7);")
        assert.ok(child.code.source.includes("enter"))
    })
})

describe("codec scope — §6's worked changes, run for real", () =>
{
    const T = struct({ a: u8 })
    const root = () => ({ container: { root: { a: 5 } }, key: "root", type: buildTypeGraph(T).root })

    function encode(rules: readonly CodecRule<void>[]): number[]
    {
        const program = buildCodec(T, rules, undefined)
        validateCodecHandles(program)
        const buffer: number[] = []
        const ext = createCodecExtension("encode", root(), buffer)
        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        return buffer
    }

    test("integerEncodeRule with carriers: the two bare 0s become i0 and o0", () =>
    {
        const structRule = codecRule(pStructFields(pStar()), (_m, _c: void, _r, s) =>
        {
            const child = s.slot().enter(s.o0, 0)
            return ir`${child.code} write(${s.i0}, 1, load_val(${child}));`
        })
        assert.deepEqual(encode([structRule]), [5])
    })

    test("§8.4's checksum fork, with the iterator allocated rather than hand-picked", () =>
    {
        const structRule = codecRule(pStructFields(pStar()), (_m, _c: void, _r, s) =>
        {
            const child = s.slot().enter(s.o0, 0)
            const sum = s.iter()
            return ir`
                ${child.code}
                write(${s.i0}, 1, load_val(${child}));
                write(${s.i0}, 1, load_val(${child}));
                clone_rd(${s.i0}, ${sum});
                seek(${sum}, -2);
                u32 total = 0;
                while (has_next(${sum}) != 0) { total = total + read(${sum}, 1); }
                write(${s.i0}, 1, total);
            `
        })
        assert.deepEqual(encode([structRule]), [5, 5, 10])
    })

    test("two independently-authored rules both allocating id 1 don't collide across the call", () =>
    {
        const structRule = codecRule(pStructFields(pStar()), (_m, _c: void, resolve, s) =>
        {
            const parked = s.iter()
            return ir`
                clone_wr(${s.i0}, ${parked});
                write(${s.i0}, 1, 111);
                call_codec(${resolve(u8, undefined)}, ${s.o0}, 0);
                write(${parked}, 1, 99);
            `
        })
        const leafRule = codecRule(pInteger(-Infinity, Infinity), (_m, _c: void, _r, s) =>
        {
            const own = s.iter()
            return ir`write(${s.i0}, 1, load_val(${s.o0})); clone_rd(${s.i0}, ${own}); u32 x = 0; x = read(${own}, 1);`
        })
        // Both scopes handed out "1"; frame scoping keeps them apart.
        assert.deepEqual(encode([structRule, leafRule]), [99, 5])
    })
})
