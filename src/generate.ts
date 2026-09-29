import type { PluginContext } from "emdash/plugin";

import { type Model, requestAlt, resolveModel } from "./claude";
import { findMediaFields, hasAlt, isPrivateUrl, isSupportedImage, publicImageUrl } from "./media";

export const MAX_IMAGES_LIMIT = 5;

export interface Settings {
	apiKey: string | null;
	model: Model;
	autoGenerate: boolean;
	overwrite: boolean;
	maxPerSave: number;
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
	const max = Number(values.get("maxPerSave") ?? 3);
	const siteUrl = typeof values.get("siteUrl") === "string" && values.get("siteUrl") ? String(values.get("siteUrl")) : ctx.site.url;
	const collections = String(values.get("collections") ?? "")
		.split(",")
		.map((slug) => slug.trim())
		.filter(Boolean);
	return {
		apiKey: typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null,
		model: resolveModel(values.get("model")),
		autoGenerate: values.get("autoGenerate") !== false,
		overwrite: values.get("overwrite") === true,
		maxPerSave: Number.isFinite(max) ? Math.min(Math.max(Math.trunc(max), 1), MAX_IMAGES_LIMIT) : 3,
		siteUrl: (siteUrl ?? "").replace(/\/+$/, ""),
		collections,
	};
}

export interface AltLogEntry {
	collection: string;
	contentId: string;
	field: string;
	locale: string;
	alt: string;
	status: "generated" | "skipped" | "error";
	message?: string;
	model: Model;
	at: string;
}

export interface FillOptions {
	collection: string;
	contentId: string;
	locale: string;
	entryTitle?: string;
	/** Rewrite alts that are already set. */
	overwrite: boolean;
	/** Upper bound on images sent to Claude in this invocation. */
	limit: number;
}

export interface FillResult {
	changed: number;
	/** Images that still need an alt after this pass (over the limit, unsupported, failed). */
	remaining: number;
	log: AltLogEntry[];
}

/**
 * Writes alt text into the image values of `data`, in place. Never throws:
 * a failure is logged and leaves the value untouched.
 */
export async function fillAlts(
	ctx: PluginContext,
	settings: Settings,
	data: Record<string, unknown>,
	options: FillOptions,
): Promise<FillResult> {
	const at = new Date().toISOString();
	const log: AltLogEntry[] = [];
	const base = { collection: options.collection, contentId: options.contentId, locale: options.locale, model: settings.model, at };
	const candidates = findMediaFields(data).filter(({ value }) => options.overwrite || !hasAlt(value));
	if (candidates.length === 0) return { changed: 0, remaining: 0, log };
	if (!settings.apiKey || !ctx.http) {
		return { changed: 0, remaining: candidates.length, log };
	}

	const work: Array<{ field: string; value: (typeof candidates)[number]["value"]; url: string }> = [];
	for (const { field, value } of candidates) {
		if (!isSupportedImage(value)) {
			log.push({ ...base, field, alt: "", status: "skipped", message: "Unsupported image format" });
			continue;
		}
		const url = publicImageUrl(value, settings.siteUrl);
		if (!url || isPrivateUrl(url)) {
			log.push({ ...base, field, alt: "", status: "skipped", message: "No public URL for this image" });
			continue;
		}
		work.push({ field, value, url });
	}

	const batch = work.slice(0, options.limit);
	const http = ctx.http;
	const apiKey = settings.apiKey;
	const results = await Promise.all(
		batch.map(async ({ field, value, url }) => {
			try {
				const result = await requestAlt(http, apiKey, {
					model: settings.model,
					imageUrl: url,
					locale: options.locale,
					entryTitle: options.entryTitle,
					field,
				});
				return { field, value, result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { field, value, result: { ok: false as const, reason: "error" as const, message } };
			}
		}),
	);

	let changed = 0;
	for (const { field, value, result } of results) {
		if (result.ok) {
			value.alt = result.alt;
			changed++;
			log.push({ ...base, field, alt: result.alt, status: "generated" });
		} else {
			log.push({ ...base, field, alt: "", status: "error", message: result.message });
			ctx.log.warn("ai-alt-text: no alt text written", { collection: options.collection, field, reason: result.message });
		}
	}
	return { changed, remaining: candidates.length - changed, log };
}

export async function saveLog(ctx: PluginContext, log: AltLogEntry[]): Promise<void> {
	if (log.length === 0) return;
	try {
		await ctx.storage.alt_log!.putMany(
			log.map((entry) => ({ id: `${entry.collection}:${entry.contentId}:${entry.field}:${entry.locale}`, data: entry })),
		);
	} catch (error) {
		ctx.log.warn("ai-alt-text: could not record the log", { error: error instanceof Error ? error.message : String(error) });
	}
}

export function entryTitle(data: Record<string, unknown>, titleField?: string | null): string | undefined {
	const value = data[titleField ?? "title"] ?? data.title ?? data.name;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
