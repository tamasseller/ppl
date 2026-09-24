/**
 * target-js — Expression wrappers for docs/reconciliation.md §5's checks:
 * validation (a policy-free trap) and a bridged edge's out-of-domain policy.
 * Each takes and returns a JS expression over a plain number, never a wire
 * bit pattern, so they compose at any site that has the numeric value.
 */
import type {Check} from "../../core/index"

/** The values a `width`-byte wire can carry once `STORE_VAL` sign-extends it. */
export function wireWindow(width: number, signed: boolean): readonly [number, number]
{
    const bits = width * 8
    return signed ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1] : [0, 2 ** bits - 1]
}

export function inDomain(expr: string, min: number, max: number, what: string): string
{
    return `inDomain(${expr}, ${min}, ${max}, ${JSON.stringify(what)})`
}

/** Apply every out-of-domain check in `checks` to `expr`. */
export function applyOutOfDomain(expr: string, checks: readonly Check[], where: string): string
{
    let out = expr
    for(const c of checks)
    {
        if(c.cause !== "out-of-domain") continue
        const [min, max] = c.domain
        if(c.policy === "trap") out = inDomain(out, min, max, `out of domain at ${where}`)
        else if(c.policy === "saturate") out = `saturate(${out}, ${min}, ${max})`
        else out = `orReplace(${out}, ${min}, ${max}, ${c.policy.replace})`
    }
    return out
}
