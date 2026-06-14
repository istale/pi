/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/**
 * One contributing piece of the assembled system prompt. Lets the agent runtime
 * (and downstream observation) explain why the final prompt contains what it
 * contains: "this 1200-char block came from your AGENTS.md", "this guideline
 * came from a tool snippet", etc.
 */
export interface SystemPromptComponent {
	/** Stable id within this build, e.g. "custom_prompt", "context_file:0", "skill:graphify". */
	id: string;
	/** Short label for UI display. */
	label: string;
	/** Source description: file path / setting name / "computed from tools list" etc. */
	source: string;
	/** Coarse category. */
	kind:
		| "custom_prompt"
		| "default_template"
		| "append_text"
		| "context_file"
		| "skills_block"
		| "date"
		| "cwd";
	/** The actual text contributed by this component (joined together = final prompt). */
	content: string;
}

export interface BuildSystemPromptResult {
	prompt: string;
	components: SystemPromptComponent[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	return buildSystemPromptWithComponents(options).prompt;
}

/**
 * Same as buildSystemPrompt but also returns the per-component breakdown so
 * an observation layer can record provenance for each contributing piece.
 */
export function buildSystemPromptWithComponents(options: BuildSystemPromptOptions): BuildSystemPromptResult {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	const components: SystemPromptComponent[] = [];

	if (customPrompt) {
		components.push({
			id: "custom_prompt",
			label: "Custom prompt (override)",
			source: "settings: customSystemPrompt or resourceLoader.getSystemPrompt()",
			kind: "custom_prompt",
			content: customPrompt,
		});
	} else {
		const readmePath = getReadmePath();
		const docsPath = getDocsPath();
		const examplesPath = getExamplesPath();
		const tools = selectedTools || ["read", "bash", "edit", "write"];
		const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
		const toolsList =
			visibleTools.length > 0
				? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
				: "(none)";

		const guidelinesList: string[] = [];
		const guidelinesSet = new Set<string>();
		const addGuideline = (guideline: string): void => {
			if (guidelinesSet.has(guideline)) return;
			guidelinesSet.add(guideline);
			guidelinesList.push(guideline);
		};
		const hasBash = tools.includes("bash");
		const hasGrep = tools.includes("grep");
		const hasFind = tools.includes("find");
		const hasLs = tools.includes("ls");
		if (hasBash && !hasGrep && !hasFind && !hasLs) {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
		for (const guideline of promptGuidelines ?? []) {
			const normalized = guideline.trim();
			if (normalized.length > 0) addGuideline(normalized);
		}
		addGuideline("Be concise in your responses");
		addGuideline("Show file paths clearly when working with files");
		const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

		components.push({
			id: "default_template",
			label: "Default coding-agent header + tools + guidelines",
			source: "system-prompt.ts:buildSystemPrompt (default template path)",
			kind: "default_template",
			content: `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`,
		});
	}

	if (appendSection) {
		components.push({
			id: "append_system_prompt",
			label: "Appended system prompt",
			source: "resourceLoader.getAppendSystemPrompt() (often AGENTS.md or extension-injected)",
			kind: "append_text",
			content: appendSection,
		});
	}

	if (contextFiles.length > 0) {
		// One synthetic header component
		components.push({
			id: "context_files_header",
			label: "Project context wrapper",
			source: "system-prompt.ts (constant wrapper)",
			kind: "context_file",
			content: "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n",
		});
		for (let i = 0; i < contextFiles.length; i++) {
			const { path: filePath, content } = contextFiles[i];
			components.push({
				id: `context_file:${i}`,
				label: `Context file: ${filePath}`,
				source: filePath,
				kind: "context_file",
				content: `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`,
			});
		}
		components.push({
			id: "context_files_footer",
			label: "Project context wrapper (close)",
			source: "system-prompt.ts (constant wrapper)",
			kind: "context_file",
			content: "</project_context>\n",
		});
	}

	const hasReadForSkills = customPrompt ? !selectedTools || selectedTools.includes("read") : (selectedTools || ["read", "bash", "edit", "write"]).includes("read");
	if (hasReadForSkills && skills.length > 0) {
		const skillsText = formatSkillsForPrompt(skills);
		if (skillsText.length > 0) {
			components.push({
				id: "skills_block",
				label: `Skills section (${skills.filter((s) => !s.disableModelInvocation).length} visible)`,
				source: "resourceLoader.getSkills()",
				kind: "skills_block",
				content: skillsText,
			});
		}
	}

	components.push({
		id: "date",
		label: "Current date",
		source: "system-prompt.ts (Date.now)",
		kind: "date",
		content: `\nCurrent date: ${date}`,
	});
	components.push({
		id: "cwd",
		label: "Current working directory",
		source: `runtime cwd: ${promptCwd}`,
		kind: "cwd",
		content: `\nCurrent working directory: ${promptCwd}`,
	});

	const prompt = components.map((c) => c.content).join("");
	return { prompt, components };
}
