/**
 * codecs — MACs behind the crypto ops (the workspace's docs/crypto.md §4.3),
 * provided by `@noble/hashes`; keyed BLAKE2 lives with its hash in
 * `./hashes.ts`
 */

import { hmac } from "@noble/hashes/hmac"
import { kmac128, kmac256 } from "@noble/hashes/sha3-addons"
import type { CryptoParam, CryptoSpec } from "./crypto"
import { FIXED_HASHES, hashContext, keyParam, keyed, lengthParam, paramsByName } from "./hashes"

const KMACS = new Map([["KMAC128", kmac128], ["KMAC256", kmac256]])

/** Every name this file implements, in the spelling `INIT` must use. */
export const MAC_NAMES: readonly string[] = [...[...FIXED_HASHES.keys()].map(h => `HMAC-${h}`), ...KMACS.keys()]

function requiredKey(alg: string, given: ReadonlyMap<string, readonly number[]>): readonly number[]
{
    const key = given.get("key")
    if(key === undefined) throw new Error(`crypto: ${alg}: missing parameter "key"`)
    return key
}

/** `alg`'s spec under `params`, or `undefined` if `alg` is no MAC here. */
export function macSpec(alg: string, params: readonly CryptoParam[]): CryptoSpec | undefined
{
    const hashed = alg.startsWith("HMAC-") ? FIXED_HASHES.get(alg.slice(5)) : undefined
    if(hashed)
    {
        const given = paramsByName(alg, params, ["key", "tag_len"])
        const req = keyParam(alg, requiredKey(alg, given), Infinity)
        const tag = given.get("tag_len")
        const outLen = tag === undefined ? hashed.natural : lengthParam(alg, "tag_len", tag, hashed.natural)
        return { outLen, key: req, create: keyed(req, k => hashContext(outLen, hmac.create(hashed.hash, k))) }
    }

    const kmac = KMACS.get(alg)
    if(kmac)
    {
        const given = paramsByName(alg, params, ["key", "out_len", "customization"])
        const req = keyParam(alg, requiredKey(alg, given), Infinity)
        const out = given.get("out_len")
        if(out === undefined) throw new Error(`crypto: ${alg}: missing parameter "out_len"`)
        const outLen = lengthParam(alg, "out_len", out, 0xffff)
        const customization = Uint8Array.from(given.get("customization") ?? [])
        return { outLen, key: req, create: keyed(req, k => hashContext(outLen, kmac.create(k, { dkLen: outLen, personalization: customization }))) }
    }

    return undefined
}
