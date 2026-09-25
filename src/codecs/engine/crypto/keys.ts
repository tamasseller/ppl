/**
 * codecs — The host-bound key slot table (the workspace's docs/crypto.md §5):
 * each slot's requirement derived from the `INIT`s that name it, and a
 * table checked against them before a codec runs
 */

import type { RtlProgram } from "mog-core"
import { isExtInstr } from "mog-core"
import type { CodecExtInstr } from "../codec-ext-instr"
import type { KeyRequirement, KeyTable } from "./crypto"
import { cryptoSpec, keyFor } from "./crypto"

/** One requirement per slot any of `programs` keys a context from, by slot. */
export function keySlots(programs: readonly RtlProgram<CodecExtInstr>[]): KeyRequirement[]
{
    const slots = new Map<string, KeyRequirement>()
    for(const program of programs)
        for(const proc of program.procedures)
            for(const instr of proc.body)
            {
                if(!isExtInstr(instr) || instr.ext !== "INIT") continue
                const req = cryptoSpec(instr.alg, instr.params).key
                if(!req) continue
                const seen = slots.get(req.slot)
                if(seen && seen.alg !== req.alg)
                    throw new Error(`crypto: key slot "${req.slot}" is used by both ${seen.alg} and ${req.alg}; one key, one algorithm`)
                slots.set(req.slot, req)
            }
    return [...slots.values()].sort((a, b) => a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)
}

/** Throws unless `keys` holds a key each of `slots` accepts. */
export function bindKeys(slots: readonly KeyRequirement[], keys: KeyTable | undefined): void
{
    for(const req of slots) keyFor(req, keys)
}
