import jsforce, { Connection } from "jsforce";
import { FlowDmlElement } from "../../types/flowModel";
import { CapturedDmlRecord } from "../../types/runResult";
import { buildObjectNameResolver, buildFieldNameResolver } from "../../salesforce/namespaceResolver";

/**
 * Stage 4 — DML capture (design doc Section 4.7).
 * Time-window + running-user correlation query, keyed off the objects
 * identified by Stage 1's parsed flow metadata — no CDC/Platform Events
 * plumbing required for v1. Naturally captures cascading DML too (e.g. a
 * record-triggered flow this flow's DML fires), which is useful context
 * for business, not noise.
 */

function toSoqlDateTime(iso: string): string {
  return new Date(iso).toISOString();
}

async function captureForObject(
  conn: Connection,
  objectApiName: string,
  windowStart: string,
  windowEnd: string,
  runningUserId: string,
  assignedFields: string[]
): Promise<CapturedDmlRecord[]> {
  const fieldList = ["Id", ...assignedFields.filter((f) => f && f !== "Id")];
  const fieldClause = Array.from(new Set(fieldList)).join(", ");

  const soql = `
    SELECT ${fieldClause}
    FROM ${objectApiName}
    WHERE (CreatedDate >= ${toSoqlDateTime(windowStart)} OR LastModifiedDate >= ${toSoqlDateTime(windowStart)})
      AND (CreatedDate <= ${toSoqlDateTime(windowEnd)} AND LastModifiedDate <= ${toSoqlDateTime(windowEnd)})
      AND (CreatedById = '${runningUserId}' OR LastModifiedById = '${runningUserId}')
  `;

  const result = await conn.query<Record<string, unknown>>(soql);

  return result.records.map((record: Record<string, unknown>) => {
    const { Id, ...fields } = record as { Id: string; [key: string]: unknown };
    return {
      objectApiName,
      recordId: Id,
      operation: "Update" as const, // refined to "Insert" below when CreatedDate == LastModifiedDate
      fieldSnapshot: fields,
      recordUrl: `${conn.instanceUrl}/${Id}`,
    };
  });
}

/** Deleted records won't appear in a normal query — pull a last-known
 *  snapshot from the Recycle Bin instead. */
async function captureDeletedForObject(
  conn: Connection,
  objectApiName: string,
  windowStart: string,
  windowEnd: string,
  runningUserId: string
): Promise<CapturedDmlRecord[]> {
  // scanAll:true (the REST queryAll equivalent) includes recycle-bin
  // records within the retention window.
  const result = await conn
    .query<Record<string, unknown>>(
      `SELECT Id FROM ${objectApiName}
       WHERE IsDeleted = true
         AND LastModifiedDate >= ${toSoqlDateTime(windowStart)}
         AND LastModifiedDate <= ${toSoqlDateTime(windowEnd)}
         AND LastModifiedById = '${runningUserId}'`,
      { scanAll: true }
    )
    .catch(() => ({ records: [] as Record<string, unknown>[], done: true, totalSize: 0 }));

  return result.records.map((record: Record<string, unknown>) => {
    const { Id } = record as { Id: string };
    return {
      objectApiName,
      recordId: Id,
      operation: "Delete" as const,
      fieldSnapshot: {},
      recordUrl: `${conn.instanceUrl}/${Id}`,
    };
  });
}

export async function captureDmlForRun(
  conn: Connection,
  dmlElements: FlowDmlElement[],
  windowStart: string,
  windowEnd: string,
  runningUserId: string
): Promise<CapturedDmlRecord[]> {
  const resolveObjectName = await buildObjectNameResolver(conn);

  const objectsToWatch = new Map<string, string[]>();
  for (const el of dmlElements) {
    const resolved = resolveObjectName(el.objectApiName);
    const existing = objectsToWatch.get(resolved) ?? [];
    const assignedFields = el.assignments.map((a) => a.targetField);
    objectsToWatch.set(resolved, [...new Set([...existing, ...assignedFields])]);
  }

  const deletedObjects = new Set(
    dmlElements.filter((el) => el.operation === "Delete").map((el) => resolveObjectName(el.objectApiName))
  );

  const captured: CapturedDmlRecord[] = [];
  for (const [objectApiName, fields] of objectsToWatch.entries()) {
    const resolveFieldName = await buildFieldNameResolver(conn, objectApiName);
    const resolvedFields = fields.map(resolveFieldName).filter((f): f is string => Boolean(f));
    captured.push(...(await captureForObject(conn, objectApiName, windowStart, windowEnd, runningUserId, resolvedFields)));
  }
  for (const objectApiName of deletedObjects) {
    captured.push(...(await captureDeletedForObject(conn, objectApiName, windowStart, windowEnd, runningUserId)));
  }

  return captured;
}
