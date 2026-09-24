# Reconciliation

> **Status:** partly implemented.
> - Implemented: options-object constructors (§2.2), name matching (§4.1), `reconcile` and `resolve` (§4.2), kind mismatch (§4.3), struct fields (§4.4), union variants (§4.5) with `defaultVariant` covering both causes, declared defaults (§2.4). `src/core/reconcile.ts`, `src/target-js/engine/bridging-codec-module.ts`.
> - Not implemented: `classify` (§4.2), validation seams (§5.2), integer domains (§4.6), list length domains (§4.7), policies (§2.5), `meaning` and transforms (§2.1–§2.3), text (§2.6), their image encoding (§3.1).
> - Today a matched integer or list always bridges unchecked. Staging is §7.

Builds on codec-extension.md (`TypeNode`, `Step`, `ref` addressing) and
codec-image.md (what the image is and how it is encoded).

---

## 1. Terms

- **Origin**: the party whose build produced the image. Owns the **image tree**, authoritative for the wire.
- **Consumer**: the party generating code from a received image against its own **local tree**.
- The origin never bridges. Every conversion, check and policy is in the consumer's generated code, in both directions.
- **Domain**: the set of values a position admits, in its party's own numbering.
- A party's codec procedures and host projection share that numbering: `min..max` bounds what its codecs take and return. Host projection changes the representation (`number` vs `bigint`), never the number.
- **Canonical**: the shared numbering two domains are compared in. Never materialized.
- **Bridge** `g`: the map from the source side's numbering to the destination's. Decode: image → local. Encode: local → image.

---

# Part I — Data

## 2. Source domain

Three things are authored per party: the semantic type tree, the target
projection (host representation rules), and the codec mappings (wire rules).
Everything in this section lives on the type tree; the other two only read it.

### 2.1 Semantic tree

What must be agreed between parties, and the only thing reconciled for equality.

- Kind (`SemanticTypeKinds`).
- Struct field and union variant names.
- `meaning` on an integer leaf: a namespaced string, e.g. `si:voltage`, `time:utc-instant`, `text:codepoint`. Compatibility is string equality. Absent on both sides means "identity numbering" (today's behavior).

`meaning` must be specific enough to separate what shares a dimension:
torque and energy are both N·m; ratio, percent, dB and radian are all
dimensionless; an instant and a duration are both seconds. A `meaning` that
specific already determines its dimension, so no SI exponent vector is kept.
It must not be more specific than the quantity: an uptime and a timeout are
both `si:duration`. Roles are what field names are for.

### 2.2 Projection

How this party numbers the value. Lives on the same leaf, never required to match the peer.

| position | domain | map to canonical |
|---|---|---|
| integer | `min..max` | `toCanonical` (§2.3), identity if absent |
| list | length `minLength..maxLength`, unbounded above if `maxLength` absent | identity |
| union | its variant names | identity (names are the canonical) |
| struct | none of its own; fields are structural (§4.4) | — |
| unit | the one value | — |

Readers of the domain, none of which reads the other side's:
- Codec mappings read the origin's domains. E.g. the default binary rules size an integer by `intWireSize` and a count prefix by the length domain, and could omit the prefix for a fixed length.
- Target projections read the party's own domain to choose a host type by containment. E.g. `number` vs `bigint`; a fixed length could project to a tuple or a sized `Uint8Array`. The host type's domain always contains the leaf's.
- The bridge (§4) reads both.

```ts
export interface IntegerType
{
    kind: SemanticTypeKinds.Integer
    min: number
    max: number
    default?: number                 // §2.4
    meaning?: string                 // §2.1
    toCanonical?: Transform          // §2.3
    onOutOfDomain?: Policy<"trap" | "saturate" | {replace: number}>                   // §2.5
    onInexact?: Policy<"trap" | "nearest-even" | "floor" | "ceil" | "toward-zero">    // §2.5
}
```

```ts
export interface ListType
{
    kind: SemanticTypeKinds.List
    elementType: SemanticType
    minLength: number                // 0 unless given
    maxLength?: number               // absent = unbounded
    onLength?: Policy<{over?: "trap" | "truncate"; under?: "trap" | "pad"}>           // §2.5
}
// bytes(n) = list(u8, {minLength: n, maxLength: n})
```

- A length is a plain pair, not an `IntegerType`: a `meaning` or transform on a length has no use.
- A fixed length is `minLength = maxLength`. Today a list has only `capacity`, an upper bound, so fixed-length data (a MAC as `bytes(6)`) cannot be declared.
- Constructors take an options object: `integer(min, max, {default})`, `list(T, {capacity})` today; later stages add `meaning`, `toCanonical`, the policies, and replace `capacity` with `minLength`/`maxLength`. Shared constants (`u8`, …) carry no default and no policy; a leaf that needs either is its own type object, as `default` already is.

`meaning` and `toCanonical` are on the leaf, not a `named()` side channel:
type names never travel on the wire, and both of these must.

### 2.3 Transform

Total on a declared domain, deterministic, composable, invertible.

```ts
export interface Rational { readonly num: number; readonly den: number }  // normalized, den > 0

export type Transform =
    | {readonly op: "identity"}
    | {readonly op: "affine"; readonly scale: Rational; readonly offset: Rational}           // c = scale·x + offset
    | {readonly op: "log"; readonly base: Rational; readonly factor: Rational; readonly reference: Rational}  // c = reference·base^(x/factor)
    | {readonly op: "table"; readonly points: readonly (readonly [number, number])[]; readonly interp: "none" | "linear"}
```

- Scale is an exact rational, never a float: chains compose exactly, a power-of-two ratio is decidable (emit a shift), identity is recognizable (emit nothing).
- `log`'s `reference` is mandatory: dBm vs dBV vs dBFS is where dB bugs live.
- `compose` returns `readonly Transform[]`, normalized by folding adjacent affines and dropping identities. Only affine is closed under composition.
- Inversion: affine iff `scale ≠ 0`; log always; table iff injective (`interp: "none"`) or strictly monotonic (`"linear"`). Checked at build time.
- `table` is the only op total on less than its input range: it is total on its own point set (§2.6).
- Exactness (every source value lands on an integer) is decidable for affine and table.
- The contract is the scope test: a candidate needs a shared canonical and a map to it that is total on a declared domain, deterministic and invertible. DNS resolution fails all four, so a hostname and an IPv4 address are a `union`, not an op (§6).
- GPS/TAI vs UTC is affine only within one leap era; across eras it is a `table`, invertible except for the one ambiguous second at a positive leap. That ambiguity is in the timescales.

### 2.4 Declared defaults

The value for a slot the other side does not have. Owned by whichever tree has the slot: only that tree knows the slot exists, so it is data, not a policy.

- Integer: `default`, optional, no implicit value. Must lie in the leaf's own domain.
- Unit: none needed.
- List: none authored. `minLength` copies of the element's default; empty when `minLength = 0`. None if `minLength > 0` and the element has none.
- Struct: the composition of its fields' defaults, never authored as one literal. None if any field has none.
- Union: opt-in `defaultVariant`, restricted to a `unit` variant. A union with no natural fallback declares none.
- A default is in its owner's numbering and is used where that numbering applies: the image's default is written straight to the wire (encode), the local default straight into local storage (decode). A default never passes through a bridge.
- A default needed by §4.4 and not declared is a build error when the trees are reconciled. Which defaults are needed is known then.
- A field without a default is therefore required, in both directions: a peer lacking it cannot decode into this tree, and cannot encode against an image carrying it.
- Authoring rule: declare the default when the field is added (Avro's convention), unless the field is meant to be required.
- Today `integer()` defaults `default` to `0` and never checks it against `min..max`.

### 2.5 Policies

What to do with a value the destination domain cannot hold. Always the consumer's, declared on the local leaf, never shipped.

| cause | where | choices |
|---|---|---|
| out of domain | integer | `trap`, `saturate` (clamp to nearest bound of the destination domain), `{replace: v}` |
| inexact | integer, transform not exact | `trap`, a rounding mode |
| unknown variant | union | `trap`, `{replace: name}` (a `unit` variant present on both sides, checked at build time) |
| over length | list | `trap`, `truncate` |
| under length | list | `trap`, `pad` (with the element's default; build error if it has none) |

- `Policy<P> = P | {decode?: P; encode?: P}`: one policy for both directions, or one per direction.
- `{replace: v}` is always in local numbering. On encode it is bridged like any value and must land exactly in the image's domain, else build error when the image is reconciled.
- `saturate` and rounding are defined against the destination domain and need no such rule.
- A partial edge (§4.3) with no policy for its cause is a build error, not a runtime trap. `trap` has to be written. Consequence: an image whose domain grew fails when that image is first reconciled, not on the first message that carries a new value.
- Absence is not a cause here. It is §2.4's default, owned by the slot's tree: on encode the consumer has no leaf for an image-only field to hang a policy on.
- Today `defaultVariant` serves as both the absent default and an unknown-variant `{replace}`. Splitting them lets "decoded as X" and "arrived as something this build does not know" be told apart.

### 2.6 Text

A string is `list(integer)`; the element's `meaning` is `text:codepoint`, canonical is the Unicode scalar value.

- ASCII: `identity` over `0..127`. Latin-1: `identity` over `0..255`. Unicode: `identity` over `0..1114111`.
- Windows-1252, KOI8-R: `table` over `0..255`, `interp: "none"`.
- ASCII → Unicode is total and folds to nothing. Unicode → ASCII is partial, decided per value by `onOutOfDomain`.
- Code maps are injective and not monotonic (1252: `0x82` → U+201A, `0x83` → U+0192), which is why inversion is split by `interp`.
- A code page is partial: 1252 assigns nothing to `0x81 0x8D 0x8F 0x90 0x9D`. Those are out of the table's domain, so out-of-domain policy applies.
- Surrogates `D800..DFFF` are not scalar values; `0..1114111` over-approximates them. Same gap as "one of an enum's members".
- Encoding (UTF-8/16) and storage (buffer, `std::string`) never reach the leaf. Multi-byte code pages (Shift-JIS) do not fit per-element transforms and decompose into a table (JIS X 0208) plus an encoding.

## 3. Renderings

### 3.1 Codec image

- Carries the origin's semantic tree with its projection: kinds, names, `min`/`max`/`default`, `minLength`/`maxLength`, `defaultVariant`, and (proposed) `meaning` and `toCanonical`.
- Carries no policies. They are the consumer's.
- Encoder and decoder programs as the origin compiled them; reconciliation never rewrites them.
- Proposed encoding, in codec-image.md §3.2's integer push instructions, folded into the tag the way `min = 0` and `default = 0` fold:
  - `meaning`: an index into codec-image.md §3.3's string table.
  - Optional `default`: the `default = 0` folds become "no default" folds, and the canonical `PUSH_U8`… tags carry none.
  - Transform: a tag byte and operands. Rational is zigzag-LEB128 numerator, LEB128 denominator.
  - `table`s are interned in a table of their own, indexed like strings. A code page is 256 points and shared by construction.
  - `LIST_EXT` carries both length bounds, with folds for `minLength = 0` and for a fixed length.

### 3.2 Origin's generated code

- Codec procedures plus the host projection, against one tree. No bridge.
- Still has both validation seams (§5.2): what came off the wire, and what the application handed in.

### 3.3 Consumer's generated code

- The image's codec procedures, raised as-is, plus the bridge, plus the local host projection.
- Bridge code is emitted only for partial or converting edges. A total identity edge compiles exactly like origin code.

---

# Part II — Behaviour

## 4. Reconciliation

### 4.1 Matching by name

- Struct fields and union variants match by name, never by `ref` index.
- A list's one element edge needs no name.
- The image's `ref` operands stay positional into the image tree forever. Reconciliation is a codegen-time bridge, not a transformation of the image.

### 4.2 The walk and `resolve`

```ts
export function reconcile(imageRoot: TypeNode, localRoot: TypeNode): Correspondence
export function resolve(parent: Correspondence, edge: CorrespondenceEdge, direction: Direction): Resolution
```

- `reconcile` is the direction-agnostic lock-step walk. Each node is `matched`, `image-only` or `local-only`.
- Memoized on the `(imageNode, localNode)` pair, reserved before recursing, so a cycle or shared type returns the same `Correspondence`. Names live on edges, never on nodes, for the same reason as `TypeEdge`.
- `resolve` is direction-aware and per edge. Its parent must be `matched`: a non-bridged edge's resolution covers everything inside it.
- Proposed: a third function classifies a matched leaf for one direction (§4.3):

```ts
export function classify(c: Correspondence, direction: Direction): Resolution  // throws on empty
```

- It needs no parent, so any slot can call it: an integer at `STORE_VAL`/`LOAD_VAL`, a list element reached by `CALL_CODEC_NEXT` (which never goes through `resolve`), a list's length at open/close.
- `resolve` stays structural: absent fields, variants, and a bare `bridge` for a matched edge. `reconcile` stays direction-agnostic.

### 4.3 Edge classes

Every edge, for one direction, falls in exactly one class. Decided at build time.

| class | condition | generated code |
|---|---|---|
| total | `g(D_src) ⊆ D_dst` and `g` exact on `D_src` | conversion only; nothing for identity |
| partial | `g(D_src) ⊄ D_dst` and `g(D_src) ∩ D_dst ≠ ∅`, or `g` is inexact | conversion, check, policy (§2.5) |
| empty | kind differs, `meaning` differs, or `g(D_src) ∩ D_dst = ∅` | build error |
| absent | the slot exists on one side only | default from the slot's owner, or drop (§4.4) |

- Kind change is empty: kind-changing evolution is out of scope.
- `meaning` differs is empty even if both numberings coincide. That is the bug class `meaning` exists for; counts vs millivolts is not it (A.3).
- Range and precision drift are not checks of their own; they fall out of pushing `D_src` through `g`.

### 4.4 Struct fields — absent

A struct field is the only additive position: another field being absent changes nothing about how the rest is read.

| side | direction | resolution |
|---|---|---|
| image-only | decode | `drop`: the codec still reads it, so the cursor stays right; nothing is stored |
| image-only | encode | `default`, the image's |
| local-only | decode | `default`, the local tree's, set where the decoder creates the container |
| local-only | encode | `drop`: the image's bytecode never addresses it |

- Only the root is caller-supplied; every nested container is created by the decoder mid-walk. So a local-only field has nothing to keep and needs the local default.
- Either `default` missing is a build error (§2.4).
- How a default is applied (assignment, or baked into a memory layout) is the target's choice.

### 4.5 Union variants — partial on the variant set

A variant set is a domain. A variant missing on the destination side is an out-of-domain value, not an absent slot.

| side | direction | resolution |
|---|---|---|
| image-only | decode | `onUnknownVariant`: `{replace}` or `trap`. The codec still reads the payload. |
| image-only | encode | `unreachable`: the local value's active variant is always a local one |
| local-only | decode | `unreachable`: the wire tag is always an image one |
| local-only | encode | `onUnknownVariant`: `{replace}` or `trap` |

- `unreachable` still compiles to a throw: the bytecode instruction exists.
- Today: image-only/decode is `default` via `defaultVariant`, else a runtime trap; local-only/encode is always a runtime trap.

### 4.6 Integers

For a matched integer leaf and a direction:
1. `meaning` differs → empty.
2. `g = f_dst⁻¹ ∘ f_src`, normalized (§2.3).
3. `g(D_src)` against `D_dst` → total, partial or empty.
4. `g` inexact on `D_src` → partial, `onInexact` applies.

- The wire width is always the image's; the local domain bounds only local storage.
- Encode: `D_src` is the local domain, so a local range wider than the image's is partial and needs `onOutOfDomain`.
- A composed affine with `|scale| < 1` means the destination is coarser: inexact unless every source value lands on an integer.

### 4.7 Lists

- Element edge: always matched; what diverges inside it resolves at that position.
- Length: `D` is `minLength..maxLength`, `g` is identity. Classified like an integer domain (§4.3).
- Decode: local `maxLength` below the image's is partial (`over`); local `minLength` above the image's is partial (`under`). Encode is the mirror.
- Disjoint length domains (`bytes(4)` vs `bytes(6)`) are empty.

### 4.8 Resolution

```ts
export type Resolution =
    | {readonly action: "bridge"; readonly transform?: readonly Transform[]; readonly checks?: readonly Check[]}
    | {readonly action: "drop"}
    | {readonly action: "default"; readonly value: unknown}
    | {readonly action: "unreachable"}

export type Check =
    | {readonly cause: "out-of-domain"; readonly domain: readonly [number, number]; readonly policy: "trap" | "saturate" | {replace: number}}
    | {readonly cause: "inexact"; readonly policy: "trap" | RoundingMode}
    | {readonly cause: "unknown-variant"; readonly policy: "trap" | {replace: string}}
    | {readonly cause: "over-length"; readonly maxLength: number; readonly policy: "trap" | "truncate"}
    | {readonly cause: "under-length"; readonly minLength: number; readonly policy: "trap" | "pad"}
```

- `transform`/`checks` absent is exactly today's bare `bridge`. One edge can carry both an inexact and an out-of-domain check.
- `trap` is no longer an action: it is a check's policy. `unknown-variant` with `{replace}` subsumes today's union `default`.

## 5. Generated code

### 5.1 Pipeline

```
decode:  wire ─codec─▶ x ∈ D_image ─[validate]─▶ ─[bridge g, check]─▶ y ∈ D_local ─fromWire─▶ host
encode:  host ─toWire─▶ y ─[validate]─▶ y ∈ D_local ─[bridge g⁻¹, check]─▶ x ∈ D_image ─codec─▶ wire
```

- Codec: the image's procedures, from codec libraries or user-written.
- Validate: §5.2. Present in origin and consumer code alike.
- Bridge: consumer only; §4's resolution for this edge.
- Host projection: the target rule's `Accessor` (`fromWire`/`toWire`). Always total: the host type contains the leaf's domain (§2.2).

### 5.2 Invariants

- Codec procedures only ever see values in the image's domain, in the image's numbering. On encode they may rely on it (bit packing, delta coding); on decode their output is validated before anything else sees it.
- The bridge sits strictly outside codec procedures. Codec-internal state (e.g. a delta coder's previous value) is in image numbering.
- Validation checks input coming from outside generated code: wire bytes on decode (`x ∈ D_image`, including a decoded length), application values on encode (`y ∈ D_local`). Failure is a policy-free trap (malformed message, invalid argument). It is not a reconciliation question.
- A validation is elided when the producer guarantees it: a fixed wire width whose full range is the domain, or a host type no wider than the domain.
- A bridge check is elided when the edge is total.
- Defaults (§2.4) enter after the bridge on decode and before the codec on encode, in their owner's numbering.

### 5.3 Check sites

| position | decode | encode |
|---|---|---|
| integer | `STORE_VAL` | `LOAD_VAL` |
| union | `CALL_CODEC` on a variant edge | `TAG` (`tagOf`) |
| list length | each append (`ENTER_NEXT`, `CALL_CODEC_NEXT`) | `COUNT`, and the length `elementAt` iterates to |
| bulk transfer | `READ_SEQ` | `WRITE_SEQ` |

- A partial element type turns a bulk transfer into a per-element loop, so a raw-buffer fast path (codec-extension.md §3.5) applies only to total edges.
- The `under` check on decode sits at the list's close, once the count is known.
- `truncate` on decode keeps running the codec, so the cursor stays right, and drops the appends past `maxLength`. On encode it presents a shortened view to `COUNT` and iteration.
- `pad` appends element defaults at close on decode; on encode it presents a lengthened view.

### 5.4 Failure delivery

- `trap`, validation failure, `unreachable`: `CodecTrap`, aborting the whole message.
- Proposed: a distinct code per cause (malformed, invalid-local, out-of-domain, inexact, unknown-variant, over-length, under-length, unreachable), plus the path of the edge.
- `saturate`, `replace`, rounding, `truncate`: inline, silent, message continues.

---

## 6. Out of scope

- **Runtime calibration.** A nominal transform is a build-time constant; a device's actual calibration is per-device data and must travel on the wire. That needs one field to scale another (IEEE 1451 TEDS), the first thing here that multiplies two quantities.
- **Sentinels** (`0x8000` = fault): `union({value, fault: unit})`, with the codec merging the sentinel into the value space (TODO.md's small-value-space merging). No NaN-likes in a leaf.
- **Shared role without a shared canonical** (hostname vs address): a `union`, per §2.3.
- **Kind-changing evolution**: empty (§4.3).
- **`meaning` on composites** (lists, structs) and their projections: reordering (a MAC as `bytes(6)` in Ethernet vs BLE order), mixing (stereo L/R vs mid/side). `meaning` stays on integer leaves.
- **One quantity as two kinds** (a MAC as `bytes(6)` on one side, a 48-bit integer on the other): a kind mismatch, empty. The shared tree picks one.

## 7. Staging

Each stage carries its own image encoding change, and its tests: classification cells in `reconcile.runtime.test.ts`, executed behavior in `bridging-codec.runtime.test.ts`. A stage that breaks existing schemas migrates `ppl-example` in the same step.

1. Done: §4.1, §4.2's `reconcile` and `resolve`, §4.4, §4.5 via `defaultVariant`, §2.4.
2. Done: options-object constructors (§2.2).
3. Optional, domain-checked `default` (§2.4), with its "no default" encoding (§3.1). Every schema relying on the implicit `0`, `ppl-example`'s included, must declare it.
4. Domains and policies, as one step:
   - `classify` (§4.2) and §4.8's `Resolution`.
   - Integer domains with identity numbering (§4.6 without `meaning`), `onOutOfDomain`.
   - List length domains (§4.7) replacing `capacity`: `onLength`, `LIST_EXT`'s two bounds, the matcher's `pList` containment on both.
   - `onUnknownVariant` split from `defaultVariant` (§4.5).
   - Validation seams (§5.2) in both the origin's generator (`generateCodecModule`) and the bridging one.
   - Closes today's unchecked range bridge.
5. `meaning`, its empty check and its encoding.
6. `affine` transforms, `onInexact`, and their encoding. Covers every epoch and geodetic scale in Appendix A.
7. `table`, its interning, and text (§2.6).
8. Target consumption: branded numbers in `target-js`, a strong type or folded multiply in C++.
9. `log`, then a `meaning` registry (J1939 SLOT as the model).

The risk is authorship. Optional metadata nobody depends on rots like
protobuf field comments; `meaning` sticks only if declaring it is what earns
free conversion in generated code.

## 8. Precedents

| | what to take |
|---|---|
| Ada fixed point | `delta` with an arbitrary rational `small`; the compiler picks the representation. |
| ASAM A2L | `COMPU_METHOD`: `LINEAR`, `RAT_FUNC`, `TAB_INTP`, `TAB_VERB`, `FORM`; SI exponents on a named `UNIT`. |
| Simulink / Embedded Coder | slope-bias scaling, power-of-two eliding the multiply. |
| CBOR tags (RFC 8949 §3.4) | a registered decorator on an existing shape: `meaning` plus a registry. |
| IEEE 1588 | TAI with `currentUtcOffset` as live wire data: §2.3's leap case and §6's calibration split. |
| SenML (RFC 8428, 8798) | a unit registry that separates ratio, `%`, `dB`, `%RH`. |
| QUDT | quantity kind separate from unit, with multiplier and offset. |
| J1939 SLOT | a catalog of named reusable scalings. |
| WHATWG Encoding | every single-byte code page as a byte→codepoint index, holes marked. |
| IEEE 1451 TEDS | the sensor carries its own calibration. |
| `std::chrono`, F# UoM, Rust `uom` | scale in the type, folded at compile time. |
| Avro | declare the default when the field is added. |

Protobuf and ASN.1 have nothing for the numeric half. ASN.1's
`IA5String`/`BMPString`/`UTF8String` put the repertoire in the type, fused
with the encoding.

---

## Appendix A — Examples

### A.1 Struct evolution

`ReadingV1 = struct({id: u8, value: i16})`, `ReadingV2` adds `quality: u8` (default `0`).

- V1 consumer, V2 image, decode: `quality` is image-only → `drop`. Its byte is still read.
- V2 consumer, V1 image, decode, `quality` inside a union payload: local-only → `default` `0`, set when the decoder creates the payload.
- V2 consumer, V1 image, encode: local-only → `drop`.
- V1 consumer, V2 image, encode: image-only → the image's `default` `0`, written to the wire.
- Had `quality` declared no default, the two `default` cases above would be build errors: `quality` would be required.
- Server's `SensorKind` lacks the device's `pressure` variant, decode: image-only → `onUnknownVariant`, e.g. `{replace: "unrecognized"}`. Without one, build error (today: runtime trap unless `defaultVariant`).

### A.2 Numberings

| `meaning` | `min..max` | `toCanonical` |
|---|---|---|
| `si:voltage` | `0..4095` | `affine{1/2048, 5/2}`: 12-bit ADC, 2.5..4.5 V |
| `si:voltage` | `2500..4200` | `affine{1/1000, 0}`: millivolts |
| `si:temperature` | `-400..1250` | `affine{1/10, 5463/20}`: deci-Celsius, canonical kelvin |
| `si:temperature` | `233150..398150` | `affine{1/1000, 0}`: millikelvin |
| `time:utc-instant` | `0..4102444800000` | `affine{1/1000, 0}`: Unix ms |
| `time:utc-instant` | `0..4294967295` | `affine{1, -2208988800}`: NTP seconds |
| `geo:longitude` | `-2^31..2^31-1` | `affine{45/2^29, 0}`: binary angle measure |
| `geo:longitude` | `-1800000000..1800000000` | `affine{1/10^7, 0}`: degrees × 1e7 |
| `text:codepoint` | `0..127` | `identity`: ASCII |
| `text:codepoint` | `0..255` | `table`: Windows-1252 |

### A.3 Bridges, decode, image → local

| image → local | `g` | class |
|---|---|---|
| ADC counts → millivolts | `affine{125/256, 2500}`, `(x*125 >> 8) + 2500` | partial: inexact; `g(0..4095)` = 2500..4500 exceeds `..4200` |
| deci-Celsius → millikelvin | `affine{100, 273150}` | total |
| BAM → degrees × 1e7 | `affine{3515625/4194304, 0}`, `(x*3515625) >> 22` | partial: inexact |
| NTP → Unix ms | `affine{1000, -2208988800000}` | partial: pre-1970 instants are out of domain |
| ASCII → Unicode | `identity` | total |
| Windows-1252 → Unicode | `table` | partial: the five holes |

Empty, build error: `si:voltage` vs `si:power`, `time:utc-instant` vs
`time:civil-instant`, `ipv4:host-address` vs `ipv4:netmask`, `geo:latitude`
vs `geo:longitude`, `si:duration` vs `time:utc-instant`. Every counts vs
millivolts pairing is in A.3 instead: the disagreement was never semantic.
