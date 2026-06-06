import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-process emitter for agent runtime observation events.
 *
 * Writes one JSON event per line to:
 *   $AOH_OBSERVATION_DIR/YYYY-MM-DD/trace_<trace_id>.jsonl
 *
 * Default dir: ~/.pi/observation
 *
 * Disabled if AOH_OBSERVATION_DISABLE=1. Failures are silently swallowed so
 * agent execution never breaks because of observation.
 */

export interface AgentEvent {
	trace_id: string;
	session_id?: string;
	event_seq: number;
	stage: string;
	source_module: string;
	ts: string;
	payload: unknown;
}

function rootDir(): string {
	const override = process.env.AOH_OBSERVATION_DIR;
	return override && override.length > 0 ? override : join(homedir(), ".pi", "observation");
}

function disabled(): boolean {
	return process.env.AOH_OBSERVATION_DISABLE === "1";
}

const seqByTrace = new Map<string, number>();

export function nextSeq(traceId: string): number {
	const current = seqByTrace.get(traceId) ?? 0;
	const next = current + 1;
	seqByTrace.set(traceId, next);
	return next;
}

export function emitAgentEvent(event: Omit<AgentEvent, "ts"> & { ts?: string }): void {
	if (disabled()) return;
	try {
		const date = new Date().toISOString().slice(0, 10);
		const dir = join(rootDir(), date);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `trace_${event.trace_id}.jsonl`);
		const line = JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() }) + "\n";
		appendFileSync(file, line, { encoding: "utf-8" });
	} catch {
		// observation must never break the agent
	}
}
