/**
 * Durable findings store — survives agent context compaction AND restarts.
 *
 * The MCP itself is stateless from the agent's perspective: tools are
 * idempotent, payloads are self-describing. But long monitoring workflows
 * still lose user-stated nuance ("ignore stETH dips under 2%", "alert me
 * only above $10k positions"). Those facts have nowhere to live unless we
 * give them a home outside conversation memory.
 *
 * Storage: JSONL, append-only, at $GRAPH_AAVE_MCP_STATE_DIR/findings.jsonl
 * (default ~/.graph-aave-mcp). One file per server install — scope by
 * namespace if you need multi-tenant separation.
 *
 * Capped at MAX_FINDINGS lines via tail-on-read; older entries stay on
 * disk for audit but aren't returned by get_session_state.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const MAX_FINDINGS_RETURNED = 200;

export interface Finding {
  id: string;
  namespace: string;
  text: string;
  tags: string[];
  createdAt: string;
}

function stateDir(): string {
  return (
    process.env.GRAPH_AAVE_MCP_STATE_DIR ||
    path.join(os.homedir(), ".graph-aave-mcp")
  );
}

function findingsPath(): string {
  return path.join(stateDir(), "findings.jsonl");
}

async function ensureDir() {
  await fs.mkdir(stateDir(), { recursive: true });
}

export async function noteFinding(
  text: string,
  options?: { namespace?: string; tags?: string[] }
): Promise<Finding> {
  await ensureDir();
  const finding: Finding = {
    id: randomUUID(),
    namespace: options?.namespace || "default",
    text,
    tags: options?.tags || [],
    createdAt: new Date().toISOString(),
  };
  await fs.appendFile(findingsPath(), JSON.stringify(finding) + "\n", "utf8");
  return finding;
}

export async function listFindings(options?: {
  namespace?: string;
  tag?: string;
  limit?: number;
}): Promise<Finding[]> {
  let raw: string;
  try {
    raw = await fs.readFile(findingsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const findings: Finding[] = [];
  for (const line of lines) {
    try {
      findings.push(JSON.parse(line) as Finding);
    } catch {
      // skip corrupt lines rather than crashing the session
    }
  }
  let filtered = findings;
  if (options?.namespace) {
    filtered = filtered.filter((f) => f.namespace === options.namespace);
  }
  if (options?.tag) {
    filtered = filtered.filter((f) => f.tags.includes(options.tag!));
  }
  // Newest last in append-only storage; reverse to "newest first".
  filtered.reverse();
  const limit = options?.limit ?? MAX_FINDINGS_RETURNED;
  return filtered.slice(0, limit);
}

export async function deleteFinding(id: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(findingsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let removed = false;
  const kept: string[] = [];
  for (const line of lines) {
    try {
      const f = JSON.parse(line) as Finding;
      if (f.id === id) {
        removed = true;
        continue;
      }
      kept.push(line);
    } catch {
      kept.push(line);
    }
  }
  if (removed) {
    await fs.writeFile(findingsPath(), kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  }
  return removed;
}

export async function getSessionState(namespace?: string): Promise<{
  namespace: string;
  storagePath: string;
  totalFindings: number;
  findings: Finding[];
  hint: string;
}> {
  const ns = namespace || "default";
  const findings = await listFindings({ namespace: ns });
  return {
    namespace: ns,
    storagePath: findingsPath(),
    totalFindings: findings.length,
    findings,
    hint:
      findings.length === 0
        ? "No saved findings yet. Use note_finding to record user-stated preferences, watched wallets, thresholds, or any context that should survive compaction."
        : "These findings persist across compaction and restart. Treat them as standing user preferences for this monitoring session.",
  };
}
