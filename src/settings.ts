import type { PluginContext } from "emdash/plugin";

import { type Model, resolveModel } from "./claude";

export interface Settings {
	apiKey: string | null;
	model: Model;
	/** Language of the alt text stored in the media library (shared by every entry). */
	mediaLanguage: string;
	onUpload: boolean;
	onSave: boolean;
	siteUrl: string;
	collections: string[];
}

/**
 * Reads every setting in two host calls: sandboxed invocations are limited to
 * 10 subrequests, and each host call counts.
 */
export async function readSettings(ctx: PluginContext): Promise<Settings> {
	const [entries, apiKey] = await Promise.all([ctx.settings.list(), ctx.settings.get<string>("apiKey")]);
	const values = new Map(entries.map(({ key, value }) => [key.replace(/^settings:/, ""), value]));
	const text = (key: string) => {
		const value = values.get(key);
		return typeof value === "string" ? value.trim() : "";
	};
	return {
		apiKey: typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null,
		model: resolveModel(values.get("model")),
		mediaLanguage: text("mediaLanguage") || ctx.site.locale || "en",
		onUpload: values.get("onUpload") !== false,
		onSave: values.get("onSave") !== false,
		siteUrl: (text("siteUrl") || ctx.site.url || "").replace(/\/+$/, ""),
		collections: text("collections")
			.split(",")
			.map((slug) => slug.trim())
			.filter(Boolean),
	};
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
