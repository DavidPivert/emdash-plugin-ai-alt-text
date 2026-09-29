import type { SandboxedPlugin } from "emdash/plugin";

import { entryTitle, handleAdmin } from "./admin";
import { processEntry } from "./entries";
import { describeMediaItem } from "./library";
import { saveLog } from "./log";
import { Budget, coversCollection, HOST_CALLS_PER_INVOCATION, readSettings } from "./settings";

/**
 * AI Alt Text — alt text for images, written by Claude.
 *
 * EmDash copies the media library's alt text into every image field left
 * without one, so the media library is where most alt text belongs:
 * - `media:afterUpload` describes new images in the media library language.
 * - Saving an entry fills what is still missing: an image with no alt text
 *   anywhere is described (media library + field), and an entry in another
 *   language gets alt text in its own language instead of the inherited one.
 * - The admin page catches up on existing images and translations.
 *
 * A failure (no key, API error, timeout) only skips the alt text: these hooks
 * never block an upload or a save. Every invocation stays within 10 host calls.
 */
const HOOK_OPTIONS = {
	// Vision calls take a few seconds; the default 5 s would cut them off.
	// Sandboxed invocations stop at 30 s of wall time.
	timeout: 25_000,
	errorPolicy: "continue",
} as const;

const plugin: SandboxedPlugin = {
	hooks: {
		"media:afterUpload": {
			...HOOK_OPTIONS,
			handler: async (event, ctx) => {
				const settings = await readSettings(ctx);
				if (!settings.onUpload || !settings.apiKey) return;
				// settings (2) + log (1) reserved.
				const entry = await describeMediaItem(ctx, settings, event.media, new Budget(HOST_CALLS_PER_INVOCATION - 3));
				await saveLog(ctx, [entry]);
			},
		},
		"content:beforeSave": {
			...HOOK_OPTIONS,
			handler: async (event, ctx) => {
				if (!event.id) return; // new entry: its language is only known after the save
				const settings = await readSettings(ctx);
				if (!settings.onSave || !settings.apiKey || !coversCollection(settings, event.collection)) return;

				// settings (2) + entry read (1) + log (1) reserved.
				const budget = new Budget(HOST_CALLS_PER_INVOCATION - 4);
				const existing = await ctx.content?.get(event.collection, event.id);
				const content = structuredClone(event.content);
				const result = await processEntry(ctx, settings, content, {
					collection: event.collection,
					id: event.id,
					locale: existing?.locale ?? ctx.site.locale ?? "en",
					title: entryTitle(content),
					phase: "before-save",
					checkSource: false,
				}, budget);
				await saveLog(ctx, result.log);
				return result.changed > 0 ? content : undefined;
			},
		},
		"content:afterSave": {
			...HOOK_OPTIONS,
			handler: async (event, ctx) => {
				if (!event.isNew) return;
				const item = event.content as { id?: unknown; locale?: unknown; data?: unknown };
				if (typeof item.id !== "string" || !item.data || typeof item.data !== "object") return;
				const settings = await readSettings(ctx);
				if (!settings.onSave || !settings.apiKey || !ctx.content?.update || !coversCollection(settings, event.collection)) return;

				// settings (2) + entry update (1) + log (1) reserved.
				const budget = new Budget(HOST_CALLS_PER_INVOCATION - 4);
				const data = structuredClone(item.data as Record<string, unknown>);
				const result = await processEntry(ctx, settings, data, {
					collection: event.collection,
					id: item.id,
					locale: typeof item.locale === "string" && item.locale ? item.locale : ctx.site.locale || "en",
					title: entryTitle(data),
					phase: "after-save",
					checkSource: true,
				}, budget);
				if (result.changed > 0) await ctx.content.update(event.collection, item.id, data);
				await saveLog(ctx, result.log);
			},
		},
	},
	routes: {
		admin: {
			handler: async (route, ctx) => handleAdmin(route.input, ctx),
		},
	},
};

export default plugin;
