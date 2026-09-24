/**
 * target-js — Expression wrappers for docs/reconciliation.md §5's checks:
 * validation (a policy-free trap), and a bridged edge's transform and policies.
 * Each takes and returns a JS expression over a plain number, never a wire
 * bit pattern, so they compose at any site that has the numeric value.
 */
import {affineTerms} from "../../core/index"
import type {Check, Transform} from "../../core/index"

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

/** The bridge on a checked number: the transform, rounded per the inexact
 *  check, then every out-of-domain check. */
export function applyBridge(expr: string, bridge: {transform?: Transform; checks?: readonly Check[]}, where: string): string
{
    let out = expr
    const checks = bridge.checks ?? []
    if(bridge.transform !== undefined)
    {
        const {mul, add, div} = affineTerms(bridge.transform)
        if(mul !== 1n) out = `(${out}) * ${mul}`
        if(add !== 0n) out = `${out} ${add < 0n ? "-" : "+"} ${add < 0n ? -add : add}`
        if(div !== 1n)
        {
            const inexact = checks.find((c): c is Extract<Check, {cause: "inexact"}> => c.cause === "inexact")!
            out = `divRound(${out}, ${div}, ${JSON.stringify(inexact.policy)}, ${JSON.stringify(`inexact value at ${where}`)})`
        }
    }
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
