import type { PluginContext } from "emdash/plugin";

import { type AltLogEntry, entryTitle, fillAlts, readSettings, saveLog, type Settings } from "./generate";
import { findMediaFields, hasAlt } from "./media";

/**
 * Block Kit admin surfaces. Every interaction is budgeted: a sandboxed
 * invocation may make at most 10 host calls, so the audit scans one collection
 * page at a time and the dashboard widget only reads the plugin's own log.
 */

type Block = Record<string, unknown>;
interface Interaction {
	type?: string;
	page?: string;
	action_id?: string;
	value?: unknown;
}

const SCAN_PAGE_SIZE = 50;
const SEP = "|";

export async function handleAdmin(input: unknown, ctx: PluginContext): Promise<{ blocks: Block[]; toast?: Record<string, string> }> {
	const interaction = (input && typeof input === "object" ? input : {}) as Interaction;
	const page = interaction.page ?? "/audit";
	if (page.startsWith("widget:")) return { blocks: await activityWidget(ctx) };

	const settings = await readSettings(ctx);
	const value = typeof interaction.value === "string" ? interaction.value : "";
	if (interaction.type === "block_action" && (interaction.action_id === "scan" || interaction.action_id === "scan-page")) {
		const [collection = "", cursor] = value.split(SEP);
		return { blocks: await scanBlocks(ctx, settings, collection, cursor || undefined) };
	}
	if (interaction.type === "block_action" && interaction.action_id === "generate") {
		const [collection = "", id = ""] = value.split(SEP);
		return generateForEntry(ctx, settings, collection, id);
	}
	return { blocks: await overviewBlocks(ctx, settings) };
}

function statusBlocks(settings: Settings): Block[] {
	const blocks: Block[] = [{ type: "header", text: "AI alt text" }];
	if (!settings.apiKey) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "No Anthropic API key",
			description: "Add your key in the plugin settings. Until then, no alt text is written.",
		});
	}
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Model", value: settings.model },
			{ label: "On save", value: settings.autoGenerate ? `On, up to ${settings.maxPerSave} image(s) per save` : "Off" },
			{ label: "Existing alt text", value: settings.overwrite ? "Rewritten" : "Kept" },
			{ label: "Image URLs from", value: settings.siteUrl || "unknown site URL" },
		],
	});
	return blocks;
}

async function imageCollections(ctx: PluginContext, settings: Settings) {
	const collections = (await ctx.schema?.listCollections()) ?? [];
	return collections.filter(
		(collection) =>
			collection.fields.some((field) => field.type === "image") &&
			(settings.collections.length === 0 || settings.collections.includes(collection.slug)),
	);
}

async function overviewBlocks(ctx: PluginContext, settings: Settings): Promise<Block[]> {
	const blocks = statusBlocks(settings);
	const collections = await imageCollections(ctx, settings);
	if (collections.length === 0) {
		blocks.push({ type: "empty", title: "No collection with an image field", description: "Nothing to audit." });
		return blocks;
	}
	blocks.push({ type: "section", text: "Check a collection for images without alt text:" });
	blocks.push({
		type: "actions",
		elements: collections.map((collection) => ({
			type: "button",
			action_id: "scan",
			label: collection.label,
			value: `${collection.slug}${SEP}`,
		})),
	});
	return blocks;
}

async function scanBlocks(ctx: PluginContext, settings: Settings, collection: string, cursor?: string): Promise<Block[]> {
	const blocks = statusBlocks(settings);
	if (!ctx.content || !collection) return [...blocks, { type: "banner", variant: "error", title: "Content access unavailable" }];
	const page = await ctx.content.list(collection, { limit: SCAN_PAGE_SIZE, cursor });
	const rows = page.items.flatMap((item) => {
		const missing = findMediaFields(item.data).filter(({ value }) => !hasAlt(value));
		if (missing.length === 0) return [];
		return [
			{
				entry: entryTitle(item.data) ?? item.slug ?? item.id,
				locale: item.locale ?? "—",
				state: item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId ? `${item.status}, unpublished changes` : item.status,
				fields: missing.map(({ field }) => field).join(", "),
				action: {
					type: "button",
					action_id: "generate",
					label: "Write alt text",
					value: `${collection}${SEP}${item.id}`,
					style: "primary",
				},
			},
		];
	});
	blocks.push({
		type: "section",
		text: `Collection "${collection}": ${rows.length} entr${rows.length === 1 ? "y" : "ies"} with images missing alt text in this page of ${page.items.length}.`,
		accessory: { type: "button", action_id: "overview", label: "All collections" },
	});
	blocks.push({
		type: "table",
		columns: [
			{ key: "entry", label: "Entry" },
			{ key: "locale", label: "Language", format: "badge" },
			{ key: "state", label: "Status" },
			{ key: "fields", label: "Images without alt", format: "code" },
			{ key: "action", label: "", format: "element" },
		],
		rows,
		page_action_id: "scan-page",
		...(page.hasMore && page.cursor ? { next_cursor: `${collection}${SEP}${page.cursor}` } : {}),
		empty_text: "Every image in this page has alt text.",
	});
	return blocks;
}

async function generateForEntry(
	ctx: PluginContext,
	settings: Settings,
	collection: string,
	id: string,
): Promise<{ blocks: Block[]; toast?: Record<string, string> }> {
	if (!ctx.content?.update || !collection || !id) {
		return { blocks: [...statusBlocks(settings), { type: "banner", variant: "error", title: "Content access unavailable" }] };
	}
	if (!settings.apiKey) {
		return { blocks: statusBlocks(settings), toast: { type: "error", message: "Add an Anthropic API key first" } };
	}
	const item = await ctx.content.get(collection, id);
	if (!item) return { blocks: statusBlocks(settings), toast: { type: "error", message: "Entry not found" } };

	const data = structuredClone(item.data);
	const result = await fillAlts(ctx, settings, data, {
		collection,
		contentId: item.id,
		locale: item.locale ?? ctx.site.locale ?? "en",
		entryTitle: entryTitle(item.data),
		overwrite: false,
		limit: settings.maxPerSave,
	});
	// Host calls: 2 (settings) + 1 (get) + up to 5 (Claude) + 1 (update) + 1 (log) = 10 at most.
	if (result.changed > 0) await ctx.content.update(collection, item.id, data);
	await saveLog(ctx, result.log);

	const blocks = statusBlocks(settings);
	blocks.push({
		type: "section",
		text: `${entryTitle(item.data) ?? item.slug ?? item.id}: ${result.changed} alt text(s) written${result.remaining > 0 ? `, ${result.remaining} still missing` : ""}.`,
		accessory: { type: "button", action_id: "scan", label: "Back to the list", value: `${collection}${SEP}` },
	});
	const written = result.log.filter((entry) => entry.status === "generated");
	if (written.length > 0) {
		blocks.push({ type: "fields", fields: written.map((entry) => ({ label: entry.field, value: entry.alt })) });
	}
	if (result.changed > 0) {
		// Plugin edits follow the collection's workflow: with revisions they land in the draft.
		blocks.push({
			type: "banner",
			title: "Alt text saved",
			description: "If this collection keeps drafts, publish the entry to put the alt text online. It stays listed here until then.",
		});
	}
	const failed = result.log.filter((entry) => entry.status !== "generated");
	if (failed.length > 0) {
		blocks.push({ type: "context", text: failed.map((entry) => `${entry.field}: ${entry.message ?? entry.status}`).join(" · ") });
	}
	return {
		blocks,
		toast:
			result.changed > 0
				? { type: "success", message: `${result.changed} alt text(s) written` }
				: { type: "error", message: "No alt text written" },
	};
}

async function activityWidget(ctx: PluginContext): Promise<Block[]> {
	let entries: AltLogEntry[] = [];
	try {
		const page = await ctx.storage.alt_log!.query({ orderBy: { at: "desc" }, limit: 50 });
		entries = page.items.map((item) => item.data as AltLogEntry);
	} catch {
		entries = [];
	}
	if (entries.length === 0) {
		return [{ type: "empty", title: "No alt text written yet", description: "Alt text appears here as content is saved.", size: "sm" }];
	}
	const generated = entries.filter((entry) => entry.status === "generated").length;
	const failed = entries.filter((entry) => entry.status === "error").length;
	const last = entries.find((entry) => entry.status === "generated");
	return [
		{
			type: "stats",
			items: [
				{ label: "Written (last 50 events)", value: generated },
				{ label: "Failed", value: failed, trend: failed > 0 ? "down" : "neutral" },
			],
		},
		...(last ? [{ type: "context", text: `Latest: "${last.alt}" (${last.collection}, ${last.at.slice(0, 10)})` }] : []),
	];
}
