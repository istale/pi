/**
 * Read pinned constraints written by the agent-observation-hub control panel.
 *
 * Snapshot file: $AOH_OBSERVATION_DIR/constraints.json
 * Default dir:   ~/.pi/observation
 *
 * Pi reads this file at the start of each user prompt and prepends the rules
 * as a system-like preamble. Missing file / parse error == empty list, never
 * raises.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PinnedConstraint {
	id: string;
	text: string;
	scope?: string;
	created_at?: string;
}

function rootDir(): string {
	const override = process.env.AOH_OBSERVATION_DIR;
	return override && override.length > 0 ? override : join(homedir(), ".pi", "observation");
}

export function loadPinnedConstraints(): PinnedConstraint[] {
	if (process.env.AOH_CONSTRAINTS_DISABLE === "1") return [];
	try {
		const path = join(rootDir(), "constraints.json");
		const raw = readFileSync(path, { encoding: "utf-8" });
		const parsed = JSON.parse(raw) as { constraints?: PinnedConstraint[] };
		return Array.isArray(parsed.constraints) ? parsed.constraints : [];
	} catch {
		return [];
	}
}

export function buildConstraintPreamble(constraints: PinnedConstraint[]): string {
	if (constraints.length === 0) return "";
	const bullets = constraints.map((c) => `- ${c.text}`).join("\n");
	return [
		"[Pinned project constraints — must follow]",
		bullets,
		"---",
		"",
	].join("\n");
}
