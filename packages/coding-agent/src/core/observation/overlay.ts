/**
 * Overlay reader + applier.
 *
 * TDD STUB — interface only. All functions intentionally throw
 * "not implemented" so the failing vitest suite tells us exactly which
 * cases need implementing (see test/overlay.test.ts).
 *
 * The 混合方案 implementation plan is documented in
 * .claude/projects/.../memory/backlog.md.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type OverlayMark = "background" | "stale" | "hidden";

export interface MessageOverlay {
	index: number;
	mark: OverlayMark;
	note?: string | null;
}

/**
 * Read the overlay snapshot file written by the hub for the given session.
 * Returns [] when the file is missing, unreadable, malformed, or when the
 * AOH_OVERLAY_DISABLE=1 environment variable is set.
 *
 * Snapshot file location: $AOH_OBSERVATION_DIR/overlays/<sessionId>.json
 * (default $AOH_OBSERVATION_DIR = ~/.pi/observation/)
 */
export function loadOverlay(_sessionId: string): MessageOverlay[] {
	throw new Error("not implemented: loadOverlay");
}

/**
 * Render the user's per-turn marks into a single annotation paragraph
 * intended to be injected as a system message right after the original
 * system prompt. Returns null when there is nothing to say.
 *
 * Sections (in stable order): STALE, BACKGROUND, HIDDEN.
 */
export function buildAnnotationMessage(_overlays: MessageOverlay[]): string | null {
	throw new Error("not implemented: buildAnnotationMessage");
}

/**
 * Apply hidden-tombstone replacement to the messages array.
 *
 * Does NOT insert the annotation message — that's the caller's job at
 * the LLM-message layer (where role: "system" is available). This module
 * only:
 *   - active/background/stale: leave the message untouched
 *   - hidden: replace `content` with a short tombstone string while
 *     preserving role, toolCallId, toolName, timestamp, model, etc.
 */
export function applyOverlayToMessages(
	_messages: AgentMessage[],
	_overlays: MessageOverlay[],
): AgentMessage[] {
	throw new Error("not implemented: applyOverlayToMessages");
}
