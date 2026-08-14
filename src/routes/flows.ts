/**
 * DEPRECATED — org-based flow listing (Tooling API FlowVersionView query)
 * belonged to the pre-pivot design where Stage 1 read metadata live from
 * Salesforce. As of the local-file pivot (design doc addendum), Stage 1
 * reads a .flow-meta.xml file from disk instead, so there's no "list
 * flows in this org" step anymore — the user provides a file path
 * directly to POST /api/test-runs.
 *
 * Not deleted (sandbox file-lock during this session), not wired into
 * server.ts, and intentionally exports nothing route-shaped so it can't
 * be accidentally mounted again without noticing this note first.
 */
export {};
