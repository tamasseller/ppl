# Codec Image

> **Status:** implemented. §3 (type tree wire encoding) and §4 (container
> layout) are `src/codecs/engine/type-tree-wire.ts` and
> `engine/codec-image.ts`. How a consumer reconciles an image against its
> own tree is docs/reconciliation.md. Builds on docs/codec-extension.md
> throughout: `TypeNode`/`edges`/`Step` (§2.2/§2.4), `CALL_CODEC`'s `ref`
> addressing (§2.4), and the entry procedure's declared object type, the
> only type a wire image names explicitly.

---

## 1. Overview

A **codec image** is the artifact one build produces so a second,
independently-built party can generate its own native ser/des code against
the same wire format, without ever seeing the first party's source schema
and without both parties being redeployed in lockstep when the protocol
changes. It bundles:

- the semantic type tree rooted at the entry procedure's own object type
  (codec-extension.md §2.4; everything else is derived structurally by
  walking it),
- an encoder program and a decoder program, never one call graph between
  them (codec-extension.md §2.3's directionality rule),
- and a declared default value at each of its own struct fields and union
  variants that might need one (reconciliation.md §2.4). The consumer's tree
  carries its own defaults separately, never shipped in the image (§2).

The motivating shape: an embedded device builds once, generates native code
directly from its own schema at build time, and ships a codec image as a
portable description of the wire format it speaks, either embedded in
firmware or published to an artifact store. The other party (a cloud
service, a desktop or mobile client, anything able to defer codegen to
runtime) has its *own* schema, baked into *its* own build from the same
nominal protocol definition, and generates its own ser/des code on demand,
per device, from that device's published image.

**Origin**, **consumer**, **image tree** and **local tree** are as defined in
reconciliation.md §1.

---

## 2. What the image carries

- The semantic type tree, rooted at the entry procedure's declared object
  type (codec-extension.md §2.4), additionally carrying each integer's
  declared `default` and each union's declared `defaultVariant` if any
  (reconciliation.md §2.4), since an image-only field on encode reads them
  *from the image* (reconciliation.md §4.4). The consumer's defaults are
  the mirror, declared in its own schema and never crossing the wire.
  Policies never travel either (reconciliation.md §2.5).
- One encoder program, one decoder program, unchanged from what
  codec-extension.md specifies. Reconciliation is purely a codegen-time
  bridge (reconciliation.md §4.1) and changes nothing about the bytecode's shape or
  addressing.

It carries no per-resource peak-usage stats (codec-extension.md §7.2:
nothing consumes them, and this domain wants maximum compactness) and no
per-procedure header data beyond the entry's root type (codec-extension.md
§2.4: every other handle's type is derived, never declared).

---

## 3. Type tree wire encoding

### 3.1 A postorder stack machine, not a table of nodes with pointers

The bytecode already encodes a tree with zero pointers: `ref` operands
(`ENTER`/`CALL_CODEC`, codec-extension.md §2.4) are *local*, positional
into whichever node the current handle stands on rather than global indices
into a tree-wide table. The only place a node's global identity matters is
the single entry binding, handle 0 ↔ root type. Nothing downstream of
decode cares how this section represents the tree internally, only that
decode hands back the right shape, so this wire format is free to pick
whatever is most compact, independently of reconciliation and of the
program envelope.

A tree walked postorder never needs a reference to a child: by the time a
parent is described, its children are fully built and sitting where the
last few construction steps left them. That reads as a tiny stack machine:
leaves push a value; a list/struct/union pops however many children it has
and pushes the combined result. No node says "my child is over there"; the
child is whatever the machine just finished building.

### 3.2 Instructions

One byte-tag instruction stream, decoded by a stack machine over a value
stack of already-built (sub)types. The top 2 bits of the tag pick a
*family*. For the three families recurring once per tree node (`STRUCT`'s
field count, `UNION`'s variant count, `PUSH_REF`'s delta) the low 6 bits
*are* the payload, so there is no separate count or delta operand for any
realistic value (0-63, or 1-64 for the 1-based `PUSH_REF` delta). Decode is
`family = byte >> 6; payload = byte & 0x3F`:

| range | family | payload |
|---|---|---|
| `0x00`-`0x3F` | `STRUCT` | field count = payload (0-63) |
| `0x40`-`0x7F` | `UNION` | variant count = payload (0-63) |
| `0x80`-`0xBF` | `PUSH_REF` | delta = payload + 1 (1-64 constructions back, §3.4) |
| `0xC0`-`0xFF` | everything else | sub-selected by payload |

`STRUCT`/`UNION` are followed by a name specification, the range-list form
§3.3 defines, self-terminating once it has supplied exactly that many
names; `UNION` adds one more LEB128 (`0` = no default variant, else
`index + 1`, reconciliation.md §2.4). A struct or union with ≥64 members, or a `PUSH_REF` more
than 64 constructions back, falls through to the fourth family's
explicit-count escapes. Realistic schemas never reach them; they exist so
nothing silently breaks on one that does.

Fourth family (`0xC0`-`0xFF`), plain sequential tags: there is no
per-node recurrence to exploit here, so a byte per tag is already at floor.

| byte | instruction | operands |
|---|---|---|
| `0xC0` | `PUSH_UNIT` | none |
| `0xC1`-`0xC6` | `PUSH_U8` / `I8` / `U16` / `I16` / `U32` / `I32` | none; covers every constant `metamodel.ts` exports, none of which declares a default |
| `0xC7` | `PUSH_INT_MIN0_EXT` | max (LEB128); `min = 0`, no default |
| `0xC8` | `PUSH_INT_MIN0_DEF_EXT` | max, default (zigzag-LEB128); `min = 0` |
| `0xC9` | `PUSH_INT_EXT` | min, max (zigzag-LEB128); no default |
| `0xCA` | `PUSH_INT_DEF_EXT` | min, max, default: the fully general case |
| `0xCB` | `LIST` | none; `minLength = 0`, unbounded |
| `0xCC` | `LIST_MAX_EXT` | maxLength: LEB128; `minLength = 0` |
| `0xCD` | `STRUCT_EXT` | fieldCount: LEB128, then a name specification (§3.3) |
| `0xCE` | `UNION_EXT` | variantCount: LEB128, name specification, defaultIndex |
| `0xCF` | `PUSH_REF_EXT` | delta: LEB128 |
| `0xD0` | `END` | none; pop the one remaining value (which must be the only one left) as the root type, section over |
| `0xD1` | `MEANING` | string-table index: LEB128; pops an integer, pushes it with that `meaning` |
| `0xD2` | `LIST_FIXED_EXT` | length: LEB128; `minLength = maxLength` |
| `0xD3` | `LIST_RANGE_EXT` | minLength, maxLength: LEB128 |
| `0xD4` | `LIST_MIN_EXT` | minLength: LEB128; unbounded |
| `0xD5` | `AFFINE` | scale, offset: each a zigzag-LEB128 numerator then a LEB128 denominator, unbounded; pops a meaningful integer, pushes it with `toCanonical` |
| `0xD6`-`0xFF` | reserved | |

Four integer forms rather than one general form: no default is the common
case (reconciliation.md §2.4: only a field added after its peers declares
one), and `min = 0` covers most non-canonical ranges anyway (an
arbitrary-width unsigned count or percentage, not just the six canonical
widths). Both fold independently, so all four combinations get their own
tag rather than paying for operands the common cases don't need, the same
move `wire.ts` makes for the codec opcodes. A canonical range with a
default takes a `DEF` form, never a canonical tag.

`meaning` (reconciliation.md §2.1) is a postfix `MEANING` after whichever
integer form fits, rather than a flag doubling the four forms: most integers
carry none. `MEANING` is a construction of its own (§3.4), so the plain
integer beneath it stays reachable by `PUSH_REF` too.

`toCanonical` (reconciliation.md §2.3) is a further `AFFINE` postfix after
`MEANING`, a construction of its own for the same reason. Its operands are
unbounded: NTP's epoch offset, -2208988800, already outgrows 32 bits.

Encode is a bare postorder walk, no bookkeeping beyond §3.4's:

```
encode(node):
    switch(node.type.kind)
        unit:    emit PUSH_UNIT
        integer: emit canonical PUSH_* if no default, else whichever
                 PUSH_INT_*EXT fits (min=0? default? both? neither?);
                 then MEANING(idx) if it has a meaning,
                 then AFFINE(scale, offset) if it has a toCanonical
        list:    encode(elementType); emit whichever LIST form fits its bounds
        struct:  for each field:   encode(child)
                 emit STRUCT(N, nameSpec) or, if N ≥ 64,
                      STRUCT_EXT(N, nameSpec)
        union:   for each variant: encode(child)
                 emit UNION(N, nameSpec, defaultIndex) or,
                      if N ≥ 64, UNION_EXT(...)
encode(root); emit END
```

### 3.3 String table

Field and variant names, and `meaning` strings, never appear inline. They live in a table preceding
the instruction stream: `count: LEB128`, then `count` length-prefixed UTF-8
entries, deduplicated at encode time via a `Map<string, index>` built while
walking, in first-appearance order.

The table belongs to the type tree section, not the container: the two
programs carry no names at all, addressing everything positionally via
`ref` (§3.1), and reconciliation's name matching (reconciliation.md §4.1) only ever touches
the *decoded* tree.

These names and a type's *own* declared name (`metamodel.ts`'s
`named()`/`nameOf()`) are separate namespaces. Field and variant names
travel in the image because reconciliation matches by them; a type's own
name is a build-time convenience — codegen labeling, rule matching via
`pNamed` — and never crosses the wire.

**Name specification.** `STRUCT`/`UNION` reference the string table as a
list of *ranges*, read until it has supplied exactly as many names as the
instruction's own count said to expect, so no separate range count is
needed. Unlike §3.2's outer instruction stream this sub-encoding is not
opcode-tagged: it is a private format contextually known to be exactly this
shape (a run of small integers, mostly length 1, occasionally longer), free
to use whatever is most compact.

Each range is `(base, length)`, meaning names at string-table indices
`base, base+1, …, base+length-1`, encoded as one or two LEB128 values:

- **`length = 1`** (the common case): one LEB128, `(base << 1) | 1`.
- **`length ≥ 2`**: two LEB128 values, `(length - 2) << 1` then `base`
  plain.

Decode reads one LEB128 `v`: odd means `base = v >> 1, length = 1`; even
means `length = (v >> 1) + 2` with a second LEB128 supplying `base`. Fill
that many slots from `base` upward, advance, read another range if slots
remain.

Given a fixed string-table order an encoder never needs to search for the
best partition into ranges: merging two numerically-adjacent pieces into
one longer range never costs more (one range of length *L* always costs ≤
splitting it) and often costs less, so greedily extending each run as far as
consecutiveness holds is optimal. A `length = 2` range costs the same two
LEB128 values as two separate `length = 1` entries, a wash rather than a
loss.

**Why the string table's order stays first-appearance.** A struct that is
the first place all of its own names appear already gets them as a
contiguous run for free. Doing better, reordering the whole table so names
shared *across* multiple structs and unions also end up contiguous for each
of them, is the **Consecutive Ones Property**: does a 0/1 matrix of
referrer-versus-name membership admit a column order making every row's
membership contiguous. It is decidable in linear time via a **PQ-tree**
(Booth & Lueker, 1976) when a single order satisfies every referrer at
once; when none does (three referrers pairwise sharing one name each out of
three names suffices, by pigeonhole on how many adjacent pairs a line of 3
elements has), *maximizing* how many referrers stay satisfied is NP-hard,
the same complexity class as the physical-mapping problems this structure
appears in. Implementing or lifting a PQ-tree, or a heuristic approximating
one, is real algorithmic machinery for a payoff bounded by shaving a handful
of index bytes off name lists in images that are already small. Declined
for that reason, the same bar applied to `PUSH_REF` (§3.4).

### 3.4 `PUSH_REF`: optional dedup, decode-mandatory

Every *construction* (everything except `PUSH_REF`/`PUSH_REF_EXT`) gets an
implicit sequential index by counting how many have executed. Decode
retains a table of constructions unconditionally to support `PUSH_REF` at
all, appending as it builds, which is cheap whether or not an encoder emits
one; `PUSH_REF`/`PUSH_REF_EXT` look up `table[nextIndex - delta]` and push a
copy without adding a new entry.

Discovery keys on a structural *signature*, a pure function of shape (kind,
range, default, meaning, toCanonical, length bounds, field/variant names, recursively) computed before deciding whether to
recurse into children. Keying on the emitted bytes instead never matches a
repeated composite's second occurrence: its children resolve to short
backrefs the first occurrence's construction bytes lack, so two occurrences
of the same shape never look byte-identical.

This is strictly more general than `type-graph.ts`'s object-identity
sharing, catching two independently-written `struct({a: u8, b: unit})` calls
as well as genuine fan-in through one shared thunk. It is also fully
opt-in: an encoder that never populates the map emits no `PUSH_REF` and
still produces a correct, self-contained tree. Real schemas so far
(`example`'s `Timestamp` is defined once and used in one field)
have no fan-in at all, so §3.2's postorder form does the compactness work
and `PUSH_REF` is a strictly optional refinement on top.

### 3.5 Self-framing

`END` pops the single value the whole stream must have reduced to and
asserts nothing else is left on the stack: a decode-time sanity check that
also means this section needs no outer length prefix, since decode simply
runs until `END`.

---

## 4. Container layout

Three sections concatenated in fixed order with no framing between them,
because each already knows its own length as it is produced:

1. **Type tree** (§3), self-framing via `END` (§3.5).
2. **Encoder program**, isa-core.md §5.5's format: a procedure count, then
   each procedure's own `argCount` immediately followed by its own body —
   no stored body length; decode finds where one ends by walking it (a
   body is self-delimiting, §8.4).
3. **Decoder program**, same format.

Decode reads the three in order, each consuming exactly its own bytes and
handing back the next offset. This is why `decodeProgram` returns
`{program, next}`: a single program is not self-delimiting from the
outside.
