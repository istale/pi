/**
 * TDD: tests for the Pi-side overlay module
 * (packages/coding-agent/src/core/observation/overlay.ts)
 *
 * Implements the '混合方案' from memory/backlog.md:
 *   - active     → original, untouched
 *   - background → mentioned in annotation system prompt; content unchanged
 *   - stale      → mentioned in annotation system prompt; content unchanged
 *   - hidden     → mentioned in annotation + content replaced with tombstone
 *
 * These tests will FAIL until the module is implemented (Steps 4–7).
 *
 * Run: cd packages/coding-agent && npx vitest run test/overlay.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Message } from "@earendil-works/pi-ai";
import {
	applyOverlayToMessages,
	buildAnnotationMessage,
	loadOverlay,
	type MessageOverlay,
} from "../src/core/observation/overlay.ts";

const sandboxes: string[] = [];

function makeSandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-overlay-test-"));
	sandboxes.push(dir);
	return dir;
}

function writeSnapshot(rootDir: string, sessionId: string, overlays: MessageOverlay[]) {
	const overlaysDir = join(rootDir, "overlays");
	mkdirSync(overlaysDir, { recursive: true });
	const path = join(overlaysDir, `${sessionId}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			session_id: sessionId,
			updated_at: new Date().toISOString(),
			schema_version: 1,
			overlays,
		}),
		"utf-8",
	);
	return path;
}

afterEach(() => {
	delete process.env.AOH_OBSERVATION_DIR;
	delete process.env.AOH_OVERLAY_DISABLE;
	for (const d of sandboxes.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
});

// ----------------- loadOverlay -----------------

describe("loadOverlay", () => {
	it("returns empty array when snapshot file does not exist", () => {
		const root = makeSandbox();
		process.env.AOH_OBSERVATION_DIR = root;
		expect(loadOverlay("does-not-exist")).toEqual([]);
	});

	it("reads overlays from snapshot file", () => {
		const root = makeSandbox();
		process.env.AOH_OBSERVATION_DIR = root;
		writeSnapshot(root, "sess-a", [
			{ index: 1, mark: "stale", note: "overruled" },
			{ index: 3, mark: "hidden" },
		]);
		const overlays = loadOverlay("sess-a");
		expect(overlays).toHaveLength(2);
		expect(overlays[0]).toEqual({ index: 1, mark: "stale", note: "overruled" });
		expect(overlays[1]).toEqual({ index: 3, mark: "hidden" });
	});

	it("returns empty array when snapshot is malformed JSON", () => {
		const root = makeSandbox();
		process.env.AOH_OBSERVATION_DIR = root;
		mkdirSync(join(root, "overlays"), { recursive: true });
		writeFileSync(join(root, "overlays", "sess-bad.json"), "{not valid json", "utf-8");
		expect(loadOverlay("sess-bad")).toEqual([]);
	});

	it("returns empty array when AOH_OVERLAY_DISABLE=1 even if file exists", () => {
		const root = makeSandbox();
		process.env.AOH_OBSERVATION_DIR = root;
		writeSnapshot(root, "sess-c", [{ index: 0, mark: "stale" }]);
		process.env.AOH_OVERLAY_DISABLE = "1";
		expect(loadOverlay("sess-c")).toEqual([]);
	});

	it("filters out invalid mark values", () => {
		const root = makeSandbox();
		process.env.AOH_OBSERVATION_DIR = root;
		writeSnapshot(root, "sess-d", [
			{ index: 0, mark: "stale" },
			// @ts-expect-error intentional bad value
			{ index: 1, mark: "purple" },
		]);
		const overlays = loadOverlay("sess-d");
		expect(overlays).toHaveLength(1);
		expect(overlays[0].mark).toBe("stale");
	});

	it("filters out entries with negative or non-integer index", () => {
		const root = makeSandbox();
		process.env.AOH_OBSERVATION_DIR = root;
		writeSnapshot(root, "sess-e", [
			{ index: 0, mark: "stale" },
			// @ts-expect-error intentional bad value
			{ index: -1, mark: "background" },
			// @ts-expect-error intentional bad value
			{ index: 1.5, mark: "hidden" },
		]);
		const overlays = loadOverlay("sess-e");
		expect(overlays.map((o) => o.index)).toEqual([0]);
	});
});

// ----------------- buildAnnotationMessage -----------------

describe("buildAnnotationMessage", () => {
	it("returns null when no overlays", () => {
		expect(buildAnnotationMessage([])).toBeNull();
	});

	it("returns a string when at least one overlay", () => {
		const text = buildAnnotationMessage([{ index: 0, mark: "stale" }]);
		expect(text).not.toBeNull();
		expect(typeof text).toBe("string");
	});

	it("groups marks by kind in stable order: stale, background, hidden", () => {
		const text = buildAnnotationMessage([
			{ index: 0, mark: "background" },
			{ index: 1, mark: "hidden" },
			{ index: 2, mark: "stale" },
		]) as string;
		const stalePos = text.indexOf("STALE");
		const backgroundPos = text.indexOf("BACKGROUND");
		const hiddenPos = text.indexOf("HIDDEN");
		expect(stalePos).toBeGreaterThanOrEqual(0);
		expect(backgroundPos).toBeGreaterThan(stalePos);
		expect(hiddenPos).toBeGreaterThan(backgroundPos);
	});

	it("includes turn index in each bullet", () => {
		const text = buildAnnotationMessage([
			{ index: 5, mark: "stale" },
			{ index: 9, mark: "hidden" },
		]) as string;
		expect(text).toMatch(/turn 5/);
		expect(text).toMatch(/turn 9/);
	});

	it("includes user notes when present", () => {
		const text = buildAnnotationMessage([
			{ index: 2, mark: "stale", note: "the OAuth path was wrong" },
		]) as string;
		expect(text).toMatch(/the OAuth path was wrong/);
	});

	it("does not error on null/undefined notes", () => {
		expect(() =>
			buildAnnotationMessage([
				{ index: 0, mark: "stale", note: null as any },
				{ index: 1, mark: "background", note: undefined },
			]),
		).not.toThrow();
	});

	it("only mentions kinds that actually appear", () => {
		const text = buildAnnotationMessage([{ index: 0, mark: "stale" }]) as string;
		expect(text).toMatch(/STALE/);
		expect(text).not.toMatch(/BACKGROUND/);
		expect(text).not.toMatch(/HIDDEN/);
	});

	it("keeps total output reasonable for many overlays (no runaway)", () => {
		const many: MessageOverlay[] = [];
		for (let i = 0; i < 200; i++) many.push({ index: i, mark: "background" });
		const text = buildAnnotationMessage(many) as string;
		expect(text.length).toBeLessThan(10000);
	});
});

// ----------------- applyOverlayToMessages -----------------

describe("applyOverlayToMessages", () => {
	const baseMessages: Message[] = [
		{ role: "user", content: "task A" },
		{ role: "assistant", content: "wrong approach" },
		{ role: "user", content: "correction" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "calling tool" },
				{ type: "toolUse", id: "abc", name: "bash", input: { cmd: "find ." } } as any,
			],
		},
		{
			role: "toolResult" as any,
			content: "300 lines of file listing here ...",
			toolCallId: "abc",
			toolName: "bash",
		} as any,
		{ role: "assistant", content: "main answer" },
	];

	it("returns the input unchanged when overlays is empty", () => {
		const out = applyOverlayToMessages(baseMessages, []);
		expect(out).toEqual(baseMessages);
	});

	it("does not modify message[i] for active (i.e. not in overlay list)", () => {
		const out = applyOverlayToMessages(baseMessages, [{ index: 1, mark: "stale" }]);
		expect(out[0]).toEqual(baseMessages[0]);
		expect(out[2]).toEqual(baseMessages[2]);
	});

	it("preserves the content of background-marked messages", () => {
		const out = applyOverlayToMessages(baseMessages, [{ index: 2, mark: "background" }]);
		expect(out[2].content).toEqual(baseMessages[2].content);
	});

	it("preserves the content of stale-marked messages (only annotation marks them)", () => {
		const out = applyOverlayToMessages(baseMessages, [{ index: 1, mark: "stale" }]);
		expect(out[1].content).toEqual(baseMessages[1].content);
	});

	it("replaces content of hidden-marked messages with a tombstone", () => {
		const out = applyOverlayToMessages(baseMessages, [{ index: 4, mark: "hidden" }]);
		const replaced = out[4];
		// content was changed
		expect(replaced.content).not.toEqual(baseMessages[4].content);
		// the tombstone is recognisable text
		const asText = typeof replaced.content === "string"
			? replaced.content
			: JSON.stringify(replaced.content);
		expect(asText).toMatch(/elided|hidden|tombstone/i);
	});

	it("preserves toolCallId / toolName on hidden tool results (pairing intact)", () => {
		const out = applyOverlayToMessages(baseMessages, [{ index: 4, mark: "hidden" }]);
		const replaced = out[4] as any;
		expect(replaced.toolCallId).toBe("abc");
		expect(replaced.toolName).toBe("bash");
	});

	it("preserves role on hidden messages", () => {
		const out = applyOverlayToMessages(baseMessages, [{ index: 4, mark: "hidden" }]);
		expect(out[4].role).toBe("toolResult");
	});

	it("does not change message indices (no insertion/deletion in the messages array)", () => {
		const out = applyOverlayToMessages(baseMessages, [
			{ index: 1, mark: "stale" },
			{ index: 2, mark: "background" },
			{ index: 4, mark: "hidden" },
		]);
		expect(out.length).toBe(baseMessages.length);
	});

	it("handles multiple hidden messages in a row", () => {
		const out = applyOverlayToMessages(baseMessages, [
			{ index: 3, mark: "hidden" },
			{ index: 4, mark: "hidden" },
		]);
		expect(out[3].content).not.toEqual(baseMessages[3].content);
		expect(out[4].content).not.toEqual(baseMessages[4].content);
		expect(out[5]).toEqual(baseMessages[5]); // untouched
	});

	it("ignores overlay entries whose index is out of bounds", () => {
		expect(() =>
			applyOverlayToMessages(baseMessages, [{ index: 999, mark: "hidden" }]),
		).not.toThrow();
	});

	it("does not insert the annotation system message itself (that's the caller's job)", () => {
		// This module's responsibility is just to transform the messages array.
		// The caller (sdk.ts) wires the annotation into LLM messages separately.
		const out = applyOverlayToMessages(baseMessages, [{ index: 1, mark: "stale" }]);
		expect(out.length).toBe(baseMessages.length);
		expect(out[0].role).toBe(baseMessages[0].role);
	});

	it("preserves message structure (timestamp / api / model / etc. on assistant)", () => {
		const ms: any[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				timestamp: 12345,
				model: "MiniMax-M2.7",
				provider: "minimax",
				stopReason: "stop",
				usage: { input: 10, output: 5 },
			},
		];
		const out = applyOverlayToMessages(ms, [{ index: 0, mark: "hidden" }]) as any[];
		expect(out[0].timestamp).toBe(12345);
		expect(out[0].model).toBe("MiniMax-M2.7");
		expect(out[0].stopReason).toBe("stop");
		expect(out[0].usage).toEqual({ input: 10, output: 5 });
	});

	it("is idempotent: applying overlays twice yields the same result", () => {
		const once = applyOverlayToMessages(baseMessages, [
			{ index: 1, mark: "stale" },
			{ index: 4, mark: "hidden" },
		]);
		const twice = applyOverlayToMessages(once, [
			{ index: 1, mark: "stale" },
			{ index: 4, mark: "hidden" },
		]);
		expect(twice).toEqual(once);
	});
});
