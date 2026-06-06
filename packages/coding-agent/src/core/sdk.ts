import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { emitAgentEvent, nextSeq, sessionInitTraceId } from "./observation/emit.ts";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi enables the default built-in tools (read, bash, edit, write)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	{
		const sessionIdForInit = sessionManager.getSessionId();
		const initTrace = sessionInitTraceId(sessionIdForInit);
		const skillsResult = resourceLoader.getSkills();
		const promptsResult = resourceLoader.getPrompts();
		const agentsFiles = resourceLoader.getAgentsFiles();
		emitAgentEvent({
			trace_id: initTrace,
			session_id: sessionIdForInit,
			event_seq: nextSeq(initTrace),
			stage: "resource_loaded",
			source_module: "coding-agent/sdk.ts",
			payload: {
				cwd,
				agentDir,
				skills: skillsResult.skills.map((s) => ({
					name: s.name,
					description: s.description,
					filePath: s.filePath,
					baseDir: s.baseDir,
					disableModelInvocation: s.disableModelInvocation,
				})),
				prompt_templates: promptsResult.prompts.map((p) => ({
					name: p.name,
					description: p.description,
					filePath: p.filePath,
				})),
				agents_files: agentsFiles.agentsFiles.map((f) => ({
					path: f.path,
					content_length: f.content.length,
				})),
				skill_diagnostics: skillsResult.diagnostics,
				prompt_diagnostics: promptsResult.diagnostics,
			},
		});
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	// Cut 6c: mutable ref so the streamFn (set up before the AgentSession is
	// constructed) can publish the per-model-call trace_id + start time onto
	// the session as soon as the session is attached. message_end uses these
	// to emit an assistant_message_finalized event with latency.
	const observationLinkRef: { session: AgentSession | null; lastStartMs: number } = {
		session: null,
		lastStartMs: 0,
	};

	// Cut 6g: wrap convertToLlmWithBlockImages so each call is observable.
	// convertToLlm fires per model call (right before streamFn), so this
	// gives provenance for AgentMessage[] -> LLM Message[] transformation
	// — specifically: how many messages came in vs went out (should match
	// 1:1), which messages had images dropped by blockImages, and the role
	// histogram on both sides.
	const observedConvertToLlm = (messages: AgentMessage[]): Message[] => {
		const inRoles: Record<string, number> = {};
		for (const m of messages) {
			const r = (m as { role?: string }).role ?? "unknown";
			inRoles[r] = (inRoles[r] ?? 0) + 1;
		}
		const inImageCount = messages.reduce((acc, m) => {
			const c = (m as { content?: unknown }).content;
			if (Array.isArray(c)) {
				return acc + c.filter((b) => (b as { type?: string })?.type === "image").length;
			}
			return acc;
		}, 0);

		const converted = convertToLlmWithBlockImages(messages);

		const outRoles: Record<string, number> = {};
		for (const m of converted) {
			const r = (m as { role?: string }).role ?? "unknown";
			outRoles[r] = (outRoles[r] ?? 0) + 1;
		}
		const outImageCount = converted.reduce((acc, m) => {
			const c = (m as { content?: unknown }).content;
			if (Array.isArray(c)) {
				return acc + c.filter((b) => (b as { type?: string })?.type === "image").length;
			}
			return acc;
		}, 0);

		try {
			const traceId = observationLinkRef.session?._observationLastModelCallTraceId ?? null;
			if (traceId) {
				emitAgentEvent({
					trace_id: traceId,
					session_id: observationLinkRef.session?.sessionId,
					event_seq: nextSeq(traceId),
					stage: "convert_to_llm",
					source_module: "coding-agent/sdk.ts:convertToLlmWithBlockImages",
					payload: {
						input_message_count: messages.length,
						output_message_count: converted.length,
						input_role_histogram: inRoles,
						output_role_histogram: outRoles,
						image_count_before: inImageCount,
						image_count_after: outImageCount,
						images_filtered: inImageCount - outImageCount,
						block_images_enabled: settingsManager.getBlockImages(),
					},
				});
			}
		} catch {
			// observation must never break the agent
		}
		return converted;
	};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: observedConvertToLlm,
		streamFn: async (model, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const traceId = randomUUID();
			observationLinkRef.lastStartMs = Date.now();
			if (observationLinkRef.session) {
				observationLinkRef.session._observationLastModelCallTraceId = traceId;
			}
			const observationHeaders: Record<string, string> = {
				"X-Trace-Id": traceId,
				"X-Agent-Id": "pi",
			};
			if (options?.sessionId) {
				observationHeaders["X-Session-Id"] = options.sessionId;
			}
			emitAgentEvent({
				trace_id: traceId,
				session_id: options?.sessionId,
				event_seq: nextSeq(traceId),
				stage: "before_provider_request",
				source_module: "coding-agent/sdk.ts",
				payload: {
					model: { provider: model.provider, id: model.id, api: model.api },
					message_count: context.messages.length,
					tool_count: (context as { tools?: unknown[] }).tools?.length ?? 0,
					timeout_ms: timeoutMs,
				},
			});
			emitAgentEvent({
				trace_id: traceId,
				session_id: options?.sessionId,
				event_seq: nextSeq(traceId),
				stage: "context",
				source_module: "coding-agent/sdk.ts",
				payload: {
					model: { provider: model.provider, id: model.id, api: model.api },
					messages: context.messages,
					tools: (context as { tools?: unknown[] }).tools ?? [],
				},
			});
			return streamSimple(model, context, {
				...options,
				apiKey: auth.apiKey,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers: {
					...mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						auth.headers,
						options?.headers,
					),
					...observationHeaders,
				},
				onPayload: async (payload, model) => {
					emitAgentEvent({
						trace_id: traceId,
						session_id: options?.sessionId,
						event_seq: nextSeq(traceId),
						stage: "before_provider_payload",
						source_module: "coding-agent/sdk.ts",
						payload: { model: { provider: model.provider, id: model.id }, payload },
					});
					return options?.onPayload ? await options.onPayload(payload, model) : payload;
				},
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, model) => {
			// Cut 6c: emit model_response_meta with HTTP status / headers /
			// latency so the trace page can show "what came back from the
			// upstream LLM, not just what we sent".
			try {
				const traceId = observationLinkRef.session?._observationLastModelCallTraceId ?? null;
				if (traceId) {
					const latencyMs = observationLinkRef.lastStartMs > 0 ? Date.now() - observationLinkRef.lastStartMs : null;
					const headers = (response.headers && typeof (response.headers as { entries?: () => Iterable<[string, string]> }).entries === "function")
						? Object.fromEntries((response.headers as unknown as Headers).entries())
						: (response.headers as Record<string, string> | undefined) ?? null;
					// Redact authorization header — should never appear in observation.
					if (headers && typeof headers === "object") {
						for (const k of Object.keys(headers)) {
							if (k.toLowerCase() === "authorization") headers[k] = "[REDACTED]";
						}
					}
					emitAgentEvent({
						trace_id: traceId,
						session_id: observationLinkRef.session?.sessionId,
						event_seq: nextSeq(traceId),
						stage: "model_response_meta",
						source_module: "coding-agent/sdk.ts:onResponse",
						payload: {
							status: response.status,
							headers,
							latency_ms: latencyMs,
							model_provider: model.provider,
							model_id: model.id,
						},
					});
				}
			} catch {
				// observation must never break the agent
			}
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});
	const extensionsResult = resourceLoader.getExtensions();
	// Cut 6c: wire the session into the streamFn's observation closure so
	// model_response_meta + assistant_message_finalized can correlate by
	// per-call trace_id.
	observationLinkRef.session = session;

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
