import { Connection } from "jsforce";

/**
 * Shared namespace-resolution helper (design doc addendum). Two distinct
 * real situations both need this, discovered against Ravi's actual org:
 *
 * 1. A flow's own <object>/field references can be unqualified even when
 *    the real SObject/field is namespaced (Flow Builder resolves that
 *    implicitly from inside the package's own context; the REST API used
 *    here has no such context) — see dmlCapture.ts.
 * 2. When the *target org itself* has a registered namespace (as this dev
 *    org does — "RefreshPackage"), Salesforce auto-prefixes every custom
 *    object/field deployed to it, including our own reporting objects
 *    (Flow_Test_Run__c etc.) — so the plain names used in source/metadata
 *    are never the real, queryable API names in a namespaced org.
 *
 * Both are solved the same way: don't guess or hardcode a namespace,
 * resolve against the org's own describe metadata at runtime. Ambiguous or
 * unresolvable names fail loudly (object resolver) or are dropped with a
 * warning (field resolver) rather than silently guessing.
 */

export async function buildObjectNameResolver(conn: Connection): Promise<(rawName: string) => string> {
  const describeResult = await conn.describeGlobal();
  const allNames = describeResult.sobjects.map((s) => s.name);
  const exact = new Set(allNames);

  return (rawName: string): string => {
    if (exact.has(rawName)) return rawName; // already the real, queryable name
    const suffix = `__${rawName}`;
    const candidates = allNames.filter((n) => n.endsWith(suffix));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      throw new Error(
        `Could not resolve object "${rawName}" against this org's SObject list. It may not exist, or the running user may lack access to describe it.`
      );
    }
    throw new Error(
      `Object "${rawName}" is ambiguous — multiple namespaced objects match (${candidates.join(", ")}). Flagging rather than guessing which one was meant.`
    );
  };
}

export async function buildFieldNameResolver(conn: Connection, objectApiName: string): Promise<(rawName: string) => string | undefined> {
  const describeResult = await conn.sobject(objectApiName).describe();
  const allNames = describeResult.fields.map((f) => f.name);
  const exact = new Set(allNames);

  return (rawName: string): string | undefined => {
    if (exact.has(rawName)) return rawName;
    const suffix = `__${rawName}`;
    const candidates = allNames.filter((n) => n.endsWith(suffix));
    if (candidates.length === 1) return candidates[0];
    console.warn(
      candidates.length === 0
        ? `Field "${rawName}" not found on ${objectApiName} — omitting from the payload rather than failing outright.`
        : `Field "${rawName}" on ${objectApiName} is ambiguous (${candidates.join(", ")}) — omitting rather than guessing.`
    );
    return undefined;
  };
}

/** Remaps every key of a field-value payload through a field resolver,
 *  dropping unresolvable fields (already warned inside the resolver). */
export function resolveFieldPayload<T extends Record<string, unknown>>(
  resolveFieldName: (rawName: string) => string | undefined,
  payload: T
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const resolvedKey = resolveFieldName(key);
    if (resolvedKey) resolved[resolvedKey] = value;
  }
  return resolved;
}
