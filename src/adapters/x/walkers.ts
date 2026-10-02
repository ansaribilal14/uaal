/**
 * X walker slots — generalization of xthread-agent Tier 1 (DISCOVERY).
 * Walkers produce CANDIDATES ONLY; chain membership is decided later by the
 * replying_to_status data relation, never by page order (the single most
 * important xthread pattern).
 */
import type { HttpLayer } from "../../core/http.js";

export interface WalkerResult {
  outcome: "ok" | "unavailable" | "failed";
  candidates: string[];
  slot: string;
  message?: string;
}

const MAX_CANDIDATES = 50;

interface WalkerSlot {
  name: string;
  template: (rootId: string) => string;
}

const WALKER_SLOTS: WalkerSlot[] = [
  { name: "unrollnow", template: (id) => `https://unrollnow.com/status/${id}` },
  { name: "threadreaderapp", template: (id) => `https://threadreaderapp.com/thread/${id}` }
];

export async function walkThread(rootId: string, http: HttpLayer, signal?: AbortSignal): Promise<WalkerResult> {
  const failures: string[] = [];
  for (const slot of WALKER_SLOTS) {
    // politeness: at most ONE request per walker slot per run
    try {
      const res = await http.get(slot.template(rootId), { timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 });
      if (res.status === 404) {
        failures.push(`${slot.name}: 404 (unknown thread)`);
        continue;
      }
      const candidates = extractCandidateIds(res.body.toString("utf8"), rootId);
      if (candidates.length <= 1) {
        // single-candidate page = page-shape drift or dead thread; treat as empty
        failures.push(`${slot.name}: page yielded <=1 candidate`);
        continue;
      }
      return { outcome: "ok", candidates, slot: slot.name };
    } catch (err) {
      failures.push(`${slot.name}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  // root-only degradation — honest, the chain can still be root + self-replies via decoder
  return { outcome: "failed", candidates: [rootId], slot: "none", message: failures.join(" | ") || "all walker slots failed" };
}

/**
 * Candidate extraction: status/<id> links + bare snowflake-like ids, deduped
 * in first-seen order, capped at MAX_CANDIDATES — but the requested root is
 * NEVER dropped (root-guarantee pattern).
 */
export function extractCandidateIds(raw: string, rootId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string): void => {
    if (!/^\d{1,25}$/.test(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const m of raw.matchAll(/status\/(\d{15,25})/g)) push(m[1]);
  for (const m of raw.matchAll(/\b(21\d{17,22})\b/g)) push(m[1]);
  if (!seen.has(rootId)) out.unshift(rootId);
  const capped = out.slice(0, MAX_CANDIDATES);
  if (!capped.includes(rootId)) capped.unshift(rootId);
  return capped;
}
