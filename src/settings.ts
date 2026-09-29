import type { PluginContext } from "emdash/plugin";

import { type Model, resolveModel } from "./claude";

export interface Settings {
	apiKey: string | null;
	/** A key is stored but cannot be decrypted: the site's EMDASH_ENCRYPTION_KEY changed since it was saved. */
	apiKeyUnreadable: boolean;
	model: Model;
	/** Language of the alt text stored in the media library (shared by every entry). */
	mediaLanguage: string;
	/** Where mediaLanguage comes from: the plugin setting, or the site language from EmDash settings. */
	mediaLanguageFrom: "setting" | "site";
	onSave: boolean;
	siteUrl: string;
	collections: string[];
}

/**
 * Reads every setting in two host calls: sandboxed invocations are limited to
 * 10 subrequests, and each host call counts.
 */
export async function readSettings(ctx: PluginContext): Promise<Settings> {
	const [entries, apiKey] = await Promise.all([listSettings(ctx), readApiKey(ctx)]);
	const values = new Map(entries.map(({ key, value }) => [key.replace(/^settings:/, ""), value]));
	const text = (key: string) => {
		const value = values.get(key);
		return typeof value === "string" ? value.trim() : "";
	};
	return {
		apiKey: apiKey.value,
		apiKeyUnreadable: apiKey.unreadable,
		model: resolveModel(values.get("model")),
		mediaLanguage: text("mediaLanguage") || ctx.site.locale || "en",
		mediaLanguageFrom: text("mediaLanguage") ? "setting" : "site",
		onSave: values.get("onSave") !== false,
		siteUrl: (text("siteUrl") || ctx.site.url || "").replace(/\/+$/, ""),
		collections: text("collections")
			.split(",")
			.map((slug) => slug.trim())
			.filter(Boolean),
	};
}

/**
 * First letters of every setting except `apiKey` (model, mediaLanguage, onSave,
 * collections, siteUrl). Keep in sync with `settingsSchema` in the manifest.
 */
export const NON_SECRET_SETTING_PREFIXES = ["m", "o", "c", "s"] as const;

/**
 * Listing settings decrypts every value, so one undecryptable secret fails the
 * whole list. Then read the other settings by prefix, leaving the key out.
 */
async function listSettings(ctx: PluginContext): Promise<Array<{ key: string; value: unknown }>> {
	try {
		return await ctx.settings.list();
	} catch {
		const pages = await Promise.all(NON_SECRET_SETTING_PREFIXES.map((prefix) => ctx.settings.list(prefix).catch(() => [])));
		return pages.flat();
	}
}

/** Never throws: an undecryptable key reads as missing, so saves and the admin page keep working. */
async function readApiKey(ctx: PluginContext): Promise<{ value: string | null; unreadable: boolean }> {
	try {
		const value = await ctx.settings.get<string>("apiKey");
		return { value: typeof value === "string" && value.trim() ? value.trim() : null, unreadable: false };
	} catch (error) {
		ctx.log.warn("ai-alt-text: the Anthropic API key cannot be read; enter it again in the plugin settings", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { value: null, unreadable: true };
	}
}

export function coversCollection(settings: Settings, collection: string): boolean {
	return settings.collections.length === 0 || settings.collections.includes(collection);
}

/**
 * Host-call budget for one invocation. Cloudflare's sandbox runner allows 10
 * subrequests per invocation; every host call (settings, content, media,
 * storage, network) counts. Callers reserve before each call and stop early.
 */
export class Budget {
	constructor(public left: number) {}
	take(count = 1): boolean {
		if (this.left < count) return false;
		this.left -= count;
		return true;
	}
}

export const HOST_CALLS_PER_INVOCATION = 10;
