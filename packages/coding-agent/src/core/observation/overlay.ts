/**
 * Overlay reader + applier — '混合方案' from memory/backlog.md.
 *
 * The hub writes per-session marks to
 *   $AOH_OBSERVATION_DIR/overlays/<sessionId>.json
 * and we read it sync at prompt time. Marks have these effects on what
 * the model sees:
 *   - active     → original, untouched (default; never present in snapshot)
 *   - background → mentioned in system-prepend annotation; content kept
 *   - stale      → mentioned in system-prepend annotation; content kept
 *   - hidden     → mentioned in annotation + content replaced inline
 *                  with a tombstone (preserves message structure so tool
 *                  pairing stays intact)
 *
 * Failures are swallowed so observation/overlay never breaks the agent.
 * AOH_OVERLAY_DISABLE=1 forces overlays off (emergency kill switch).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type OverlayMark = "background" | "stale" | "hidden";

export interface MessageOverlay {
	index: number;
	mark: OverlayMark;
	note?: string | null;
}

const VALID_MARKS: ReadonlySet<string> = new Set(["background", "stale", "hidden"]);

const HIDDEN_TOMBSTONE =
	"[content elided by user; see annotation in system prompt for context]";

function rootDir(): string {
	const override = process.env.AOH_OBSERVATION_DIR;
	return override && override.length > 0 ? override : join(homedir(), ".pi", "observation");
}

function disabled(): boolean {
	return process.env.AOH_OVERLAY_DISABLE === "1";
}

function isValidOverlayEntry(raw: unknown): raw is MessageOverlay {
	if (typeof raw !== "object" || raw === null) return false;
	const entry = raw as Record<string, unknown>;
	const index = entry.index;
	const mark = entry.mark;
	if (typeof index !== "number") return false;
	if (!Number.isInteger(index) || index < 0) return false;
	if (typeof mark !== "string" || !VALID_MARKS.has(mark)) return false;
	return true;
}

/**
 * Read the overlay snapshot file for the given session.
 * Returns [] on any of: file missing, malformed JSON, disabled by env,
 * or no valid entries.
 */
export function loadOverlay(sessionId: string): MessageOverlay[] {
	if (disabled()) return [];
	try {
		const path = join(rootDir(), "overlays", `${sessionId}.json`);
		const raw = readFileSync(path, { encoding: "utf-8" });
		const parsed = JSON.parse(raw) as { overlays?: unknown };
		if (!Array.isArray(parsed.overlays)) return [];
		const filtered: MessageOverlay[] = [];
		for (const entry of parsed.overlays) {
			if (isValidOverlayEntry(entry)) {
				filtered.push({
					index: entry.index,
					mark: entry.mark,
					note: typeof entry.note === "string" ? entry.note : null,
				});
			}
		}
		return filtered;
	} catch {
		return [];
	}
}

/**
 * Render the user's per-turn marks into a single annotation paragraph
 * intended to be injected as a system message right after the original
 * system prompt. Returns null when there is nothing to say.
 *
 * Sections appear in stable order: STALE → BACKGROUND → HIDDEN.
 */
export function buildAnnotationMessage(overlays: MessageOverlay[]): string | null {
	if (overlays.length === 0) return null;

	const byMark = {
		stale: overlays.filter((o) => o.mark === "stale"),
		background: overlays.filter((o) => o.mark === "background"),
		hidden: overlays.filter((o) => o.mark === "hidden"),
	};

	const lines: string[] = [
		"The user has annotated this conversation with focus markers.",
		"Treat marked turns accordingly when reasoning:",
		"",
	];

	const MAX_BULLETS_PER_KIND = 30;

	const renderSection = (
		header: string,
		guidance: string,
		entries: MessageOverlay[],
	): void => {
		if (entries.length === 0) return;
		lines.push(`${header} — ${guidance}:`);
		const shown = entries.slice(0, MAX_BULLETS_PER_KIND);
		for (const o of shown) {
			const noteSuffix = o.note ? `: ${o.note}` : "";
			lines.push(`  - turn ${o.index}${noteSuffix}`);
		}
		if (entries.length > shown.length) {
			lines.push(`  - ...and ${entries.length - shown.length} more`);
		}
		lines.push("");
	};

	renderSection(
		"STALE",
		"the user marked these as overruled by later turns; treat as historical record only",
		byMark.stale,
	);
	renderSection(
		"BACKGROUND",
		"earlier side-tasks not the current focus; reference only if directly relevant",
		byMark.background,
	);
	renderSection(
		"HIDDEN",
		"content suppressed for brevity; the runs themselves succeeded",
		byMark.hidden,
	);

	return lines.join("\n");
}

function replaceContentForHidden(message: AgentMessage): AgentMessage {
	const original = (message as { content?: unknown }).content;
	if (typeof original === "string") {
		return { ...message, content: HIDDEN_TOMBSTONE } as AgentMessage;
	}
	if (Array.isArray(original)) {
		return {
			...message,
			content: [{ type: "text", text: HIDDEN_TOMBSTONE }],
		} as AgentMessage;
	}
	// Unknown shape — leave it alone to avoid silently breaking something.
	return message;
}

function isAlreadyTombstoned(message: AgentMessage): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content === HIDDEN_TOMBSTONE;
	if (Array.isArray(content) && content.length === 1) {
		const b = content[0] as { type?: string; text?: string };
		return b.type === "text" && b.text === HIDDEN_TOMBSTONE;
	}
	return false;
}

/**
 * Apply hidden-tombstone replacement to the messages array.
 *
 * This module does NOT insert the annotation — the caller (sdk.ts) wires
 * the annotation in at the LLM-message layer where `role: "system"` is
 * available.
 *
 * Out-of-bounds indices are silently ignored. Already-tombstoned messages
 * are left untouched (makes the function idempotent).
 */
export function applyOverlayToMessages(
	messages: AgentMessage[],
	overlays: MessageOverlay[],
): AgentMessage[] {
	if (overlays.length === 0) return messages;

	const hiddenIndices = new Set<number>();
	for (const o of overlays) {
		if (o.mark === "hidden") hiddenIndices.add(o.index);
	}
	if (hiddenIndices.size === 0) return messages;

	return messages.map((msg, i) => {
		if (!hiddenIndices.has(i)) return msg;
		if (i < 0 || i >= messages.length) return msg;
		if (isAlreadyTombstoned(msg)) return msg;
		return replaceContentForHidden(msg);
	});
}
