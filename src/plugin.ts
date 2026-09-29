import type { SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin";
import { entryTitle, fillAlts, readSettings, saveLog } from "./generate";

/**
 * AI Alt Text — writes alt text for images with Claude.
 *
 * - Existing entries: `content:beforeSave` fills image fields that have no alt
 *   text, in the entry's language, inside the save itself.
 * - New entries: the save hook does not receive the entry's language, so
 *   `content:afterSave` writes the alt text once the entry exists (EmDash keeps
 *   that hook alive with waitUntil). The change lands like any plugin edit: in
 *   the entry's draft when the collection uses revisions.
 *
 * Claude downloads each image from its public URL. A failure (no key, API
 * error, timeout) only skips the alt text: these hooks never block a save.
 */
const HOOK_OPTIONS = {
	// Vision calls take a few seconds each; the default 5 s would cut them off.
	// Sandboxed invocations stop at 30 s of wall time.
	timeout: 25_000,
	errorPolicy: "continue",
} as const;

const plugin: SandboxedPlugin = {
	hooks: {
		"content:beforeSave": {
			...HOOK_OPTIONS,
			handler: async (event, ctx) => {
				if (!event.id) return; // new entry: handled after the save
				const settings = await readSettings(ctx);
				if (!settings.autoGenerate || !settings.apiKey) return;
				if (settings.collections.length > 0 && !settings.collections.includes(event.collection)) return;

				const content = structuredClone(event.content);
				const existing = await ctx.content?.get(event.collection, event.id);
				const result = await fillAlts(ctx, settings, content, {
					collection: event.collection,
					contentId: event.id,
					locale: existing?.locale ?? ctx.site.locale ?? "en",
					entryTitle: entryTitle(content),
					overwrite: settings.overwrite,
					limit: settings.maxPerSave,
				});
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
				if (!settings.autoGenerate || !settings.apiKey || !ctx.content?.update) return;
				if (settings.collections.length > 0 && !settings.collections.includes(event.collection)) return;

				const data = structuredClone(item.data as Record<string, unknown>);
				const result = await fillAlts(ctx, settings, data, {
					collection: event.collection,
					contentId: item.id,
					locale: typeof item.locale === "string" && item.locale ? item.locale : ctx.site.locale || "en",
					entryTitle: entryTitle(data),
					overwrite: settings.overwrite,
					limit: settings.maxPerSave,
				});
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
