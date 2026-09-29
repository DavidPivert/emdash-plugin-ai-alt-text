import type { MediaItem, PluginContext } from "emdash/plugin";

import { processEntry } from "./entries";
import { CALLS_PER_MEDIA_ITEM, describeMediaItem, MAX_MEDIA_BYTES, needsAlt } from "./library";
import { type AltLogEntry, saveLog } from "./log";
import { findMediaFields, sameLanguage } from "./media";
import { Budget, coversCollection, HOST_CALLS_PER_INVOCATION, readSettings, type Settings } from "./settings";

/**
 * Block Kit admin surfaces. Every interaction stays within 10 host calls, so
 * lists are paginated and bulk actions handle two images at a time.
 */

type Block = Record<string, unknown>;
interface Interaction {
	type?: string;
	page?: string;
	action_id?: string;
	value?: unknown;
}
type MediaRef = Pick<MediaItem, "id" | "filename" | "mimeType" | "size">;

const PAGE_SIZE = 50;
const BULK_MEDIA = 2;
const SEP = "|";

export function entryTitle(data: Record<string, unknown>): string | undefined {
	const value = data.title ?? data.name;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function handleAdmin(input: unknown, ctx: PluginContext): Promise<{ blocks: Block[]; toast?: Record<string, string> }> {
	const interaction = (input && typeof input === "object" ? input : {}) as Interaction;
	if ((interaction.page ?? "").startsWith("widget:")) return { blocks: await activityWidget(ctx) };

	const settings = await readSettings(ctx);
	const action = interaction.type === "block_action" ? interaction.action_id : undefined;
	const value = interaction.value;
	switch (action) {
		case "media-scan":
			return { blocks: await mediaScan(ctx, settings, typeof value === "string" && value ? value : undefined) };
		case "media-describe":
			return describeMedia(ctx, settings, Array.isArray(value) ? (value as MediaRef[]) : []);
		case "scan":
		case "scan-page": {
			const [collection = "", cursor] = String(value ?? "").split(SEP);
			return { blocks: await entryScan(ctx, settings, collection, cursor || undefined) };
		}
		case "complete": {
			const [collection = "", id = ""] = String(value ?? "").split(SEP);
			return completeEntry(ctx, settings, collection, id);
		}
		default:
			return { blocks: await overview(ctx, settings) };
	}
}

function header(settings: Settings): Block[] {
	const blocks: Block[] = [{ type: "header", text: "AI alt text" }];
	if (!settings.apiKey) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "No Anthropic API key",
			description: "Add your key in the plugin settings. Until then, no alt text is written.",
		});
	}
	if (settings.mediaLanguageFrom === "site") {
		blocks.push({
			type: "banner",
			title: `Is your media library alt text in "${settings.mediaLanguage}"?`,
			description:
				"Entries in that language inherit it; entries in other languages get their own. If your site's main language is different, set \"Media library language\" in the plugin settings (for example fr).",
		});
	}
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Model", value: settings.model },
			{
				label: "Media library language",
				value: settings.mediaLanguageFrom === "setting" ? settings.mediaLanguage : `${settings.mediaLanguage} (site language from EmDash settings)`,
			},
			{ label: "New images", value: settings.onUpload ? "Described on upload" : "Off" },
			{ label: "Saving entries", value: settings.onSave ? "Completes missing and translated alt text" : "Off" },
		],
	});
	return blocks;
}

const backButton = { type: "button", action_id: "overview", label: "Back" };

async function overview(ctx: PluginContext, settings: Settings): Promise<Block[]> {
	const blocks = header(settings);
	blocks.push(
		{ type: "divider" },
		{
			type: "section",
			text: "Media library: entries inherit the alt text of their images from here.",
			accessory: { type: "button", action_id: "media-scan", label: "Find images without alt text", value: "" },
		},
		{ type: "divider" },
		{
			type: "section",
			text: `Entries: entries in "${settings.mediaLanguage}" inherit the media library alt text. Check entries in other languages to give their images alt text in their own language.`,
		},
	);
	const collections = ((await ctx.schema?.listCollections()) ?? []).filter(
		(collection) => collection.fields.some((field) => field.type === "image") && coversCollection(settings, collection.slug),
	);
	if (collections.length === 0) {
		blocks.push({ type: "context", text: "No collection has an image field." });
	} else {
		blocks.push({
			type: "actions",
			elements: collections.map((collection) => ({ type: "button", action_id: "scan", label: collection.label, value: `${collection.slug}${SEP}` })),
		});
	}
	return blocks;
}

async function mediaScan(ctx: PluginContext, settings: Settings, cursor?: string): Promise<Block[]> {
	const blocks = header(settings);
	if (!ctx.media) return [...blocks, { type: "banner", variant: "error", title: "Media access unavailable" }];
	const page = await ctx.media.list({ limit: PAGE_SIZE, cursor });
	const missing = page.items.filter(needsAlt);
	const refs: MediaRef[] = missing.map(({ id, filename, mimeType, size }) => ({ id, filename, mimeType, size }));
	blocks.push({
		type: "section",
		text: `${missing.length} image(s) without alt text in this page of ${page.items.length} media item(s). Images over ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB are described when an entry uses them.`,
		accessory: backButton,
	});
	if (refs.length > 0) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "media-describe",
					label: `Describe the first ${Math.min(BULK_MEDIA, refs.length)}`,
					style: "primary",
					value: refs.slice(0, BULK_MEDIA),
				},
			],
		});
	}
	blocks.push({
		type: "table",
		columns: [
			{ key: "file", label: "File" },
			{ key: "size", label: "Size" },
			{ key: "action", label: "", format: "element" },
		],
		rows: refs.map((ref) => ({
			file: ref.filename,
			size: ref.size === null ? "—" : `${Math.round(ref.size / 1024)} KB`,
			action: { type: "button", action_id: "media-describe", label: "Describe", value: [ref] },
		})),
		page_action_id: "media-scan",
		...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
		empty_text: "Every image in this page has alt text.",
	});
	return blocks;
}

async function describeMedia(
	ctx: PluginContext,
	settings: Settings,
	refs: MediaRef[],
): Promise<{ blocks: Block[]; toast?: Record<string, string> }> {
	const blocks = header(settings);
	if (!settings.apiKey) return { blocks, toast: { type: "error", message: "Add an Anthropic API key first" } };
	// settings (2) + log (1) reserved.
	const budget = new Budget(HOST_CALLS_PER_INVOCATION - 3);
	const log: AltLogEntry[] = [];
	for (const ref of refs.slice(0, BULK_MEDIA)) {
		if (budget.left < CALLS_PER_MEDIA_ITEM) break;
		log.push(await describeMediaItem(ctx, settings, { ...ref, url: "", createdAt: "", alt: null }, budget));
	}
	await saveLog(ctx, log);
	return resultBlocks(blocks, log, { type: "button", action_id: "media-scan", label: "Back to the media library", value: "" });
}

async function entryScan(ctx: PluginContext, settings: Settings, collection: string, cursor?: string): Promise<Block[]> {
	const blocks = header(settings);
	if (!ctx.content || !collection) return [...blocks, { type: "banner", variant: "error", title: "Content access unavailable" }];
	const page = await ctx.content.list(collection, { limit: PAGE_SIZE, cursor });
	const rows = page.items.flatMap((item) => {
		const images = findMediaFields(item.data);
		if (images.length === 0) return [];
		const locale = item.locale ?? settings.mediaLanguage;
		const first = images.find(({ value }) => value.alt?.trim())?.value.alt ?? "";
		const settled = sameLanguage(locale, settings.mediaLanguage) && images.every(({ value }) => value.alt?.trim());
		return [
			{
				entry: entryTitle(item.data) ?? item.slug ?? item.id,
				locale,
				alt: first ? (first.length > 90 ? `${first.slice(0, 90)}…` : first) : "(none)",
				action: {
					type: "button",
					action_id: "complete",
					label: settled ? "Check" : "Complete",
					value: `${collection}${SEP}${item.id}`,
					...(settled ? {} : { style: "primary" }),
				},
			},
		];
	});
	blocks.push({
		type: "section",
		text: `"${collection}": ${rows.length} entr${rows.length === 1 ? "y" : "ies"} with images in this page. Check that the alt text is in the entry's language.`,
		accessory: backButton,
	});
	blocks.push({
		type: "table",
		columns: [
			{ key: "entry", label: "Entry" },
			{ key: "locale", label: "Language", format: "badge" },
			{ key: "alt", label: "Current alt text" },
			{ key: "action", label: "", format: "element" },
		],
		rows,
		page_action_id: "scan-page",
		...(page.hasMore && page.cursor ? { next_cursor: `${collection}${SEP}${page.cursor}` } : {}),
		empty_text: "No entry with images in this page.",
	});
	return blocks;
}

async function completeEntry(
	ctx: PluginContext,
	settings: Settings,
	collection: string,
	id: string,
): Promise<{ blocks: Block[]; toast?: Record<string, string> }> {
	const blocks = header(settings);
	if (!ctx.content?.update || !collection || !id) return { blocks: [...blocks, { type: "banner", variant: "error", title: "Content access unavailable" }] };
	if (!settings.apiKey) return { blocks, toast: { type: "error", message: "Add an Anthropic API key first" } };
	const item = await ctx.content.get(collection, id);
	if (!item) return { blocks, toast: { type: "error", message: "Entry not found" } };

	// settings (2) + entry read (1) + update (1) + log (1) reserved.
	const budget = new Budget(HOST_CALLS_PER_INVOCATION - 5);
	const data = structuredClone(item.data);
	const result = await processEntry(ctx, settings, data, {
		collection,
		id: item.id,
		locale: item.locale ?? settings.mediaLanguage,
		title: entryTitle(item.data),
		phase: "after-save",
		checkSource: true,
	}, budget);
	if (result.changed > 0) await ctx.content.update(collection, item.id, data);
	await saveLog(ctx, result.log);
	const back = { type: "button", action_id: "scan", label: "Back to the list", value: `${collection}${SEP}` };
	const title = entryTitle(item.data) ?? item.slug ?? item.id;
	if (result.log.length === 0 && result.remaining === 0) {
		blocks.push({ type: "section", text: `${title}: nothing to change. Its alt text is already in its language.`, accessory: back });
		return { blocks };
	}
	const response = resultBlocks(blocks, result.log, back);
	if (result.remaining > 0) response.blocks.push({ type: "context", text: `${result.remaining} image(s) left: run it again.` });
	if (result.changed > 0) {
		response.blocks.push({
			type: "banner",
			title: "Alt text saved",
			description: "If this collection keeps drafts, publish the entry to put the alt text online.",
		});
	}
	return response;
}

function resultBlocks(blocks: Block[], log: AltLogEntry[], back: Block): { blocks: Block[]; toast?: Record<string, string> } {
	const written = log.filter((entry) => entry.status === "generated" || entry.status === "copied");
	const failed = log.filter((entry) => entry.status === "error" || entry.status === "skipped");
	blocks.push({ type: "section", text: `${written.length} alt text(s) written.`, accessory: back });
	if (written.length > 0) {
		blocks.push({
			type: "fields",
			fields: written.map((entry) => ({
				label: `${entry.field}${entry.target === "media" ? " (media library)" : ""} · ${entry.locale}`,
				value: entry.alt,
			})),
		});
	}
	if (failed.length > 0) {
		blocks.push({ type: "context", text: failed.map((entry) => `${entry.field}: ${entry.message ?? entry.status}`).join(" · ") });
	}
	return {
		blocks,
		toast: written.length > 0 ? { type: "success", message: `${written.length} alt text(s) written` } : { type: "error", message: "No alt text written" },
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
		return [{ type: "empty", title: "No alt text written yet", description: "Alt text appears here as images are uploaded and entries saved.", size: "sm" }];
	}
	const written = entries.filter((entry) => entry.status === "generated").length;
	const failed = entries.filter((entry) => entry.status === "error").length;
	const last = entries.find((entry) => entry.status === "generated");
	return [
		{
			type: "stats",
			items: [
				{ label: "Written (last 50 events)", value: written },
				{ label: "Failed", value: failed, trend: failed > 0 ? "down" : "neutral" },
			],
		},
		...(last
			? [{ type: "context", text: `Latest: "${last.alt}" (${last.collection === "media" ? "media library" : last.collection}, ${last.locale}, ${last.at.slice(0, 10)})` }]
			: []),
	];
}
