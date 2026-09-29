import type { MediaItem, PluginContext } from "emdash/plugin";

import { requestAlt } from "./claude";
import type { AltLogEntry } from "./log";
import { bytesToBase64, isSupportedImage } from "./media";
import type { Budget, Settings } from "./settings";

/**
 * Alt text for media library items, which every entry inherits.
 *
 * Plugins get no public URL for a media item (its asset URL needs a session),
 * so the image bytes are read and sent to Claude. Encoding runs inside the
 * sandbox, which has 50 ms of CPU per invocation on Cloudflare: images above
 * the cap are left for the entries that use them (sent by public URL there).
 */
export const MAX_MEDIA_BYTES = 3 * 1024 * 1024;

/** Host calls per image: read bytes, Claude, save alt text. */
export const CALLS_PER_MEDIA_ITEM = 3;

export function needsAlt(item: Pick<MediaItem, "alt" | "mimeType">): boolean {
	return !item.alt?.trim() && isSupportedImage({ id: "media", mimeType: item.mimeType });
}

export async function describeMediaItem(
	ctx: PluginContext,
	settings: Settings,
	item: MediaItem,
	budget: Budget,
): Promise<AltLogEntry> {
	const base = {
		collection: "media",
		contentId: item.id,
		field: item.filename,
		locale: settings.mediaLanguage,
		model: settings.model,
		target: "media" as const,
		at: new Date().toISOString(),
	};
	if (!needsAlt(item)) return { ...base, alt: item.alt ?? "", status: "skipped", message: "Already has alt text or unsupported format" };
	if (item.size !== null && item.size > MAX_MEDIA_BYTES) {
		return { ...base, alt: "", status: "skipped", message: "Too large to read in the sandbox; described when an entry uses it" };
	}
	if (!ctx.media?.readBytes || !ctx.media.updateMetadata || !budget.take(CALLS_PER_MEDIA_ITEM)) {
		return { ...base, alt: "", status: "skipped", message: "No budget left in this request" };
	}
	try {
		const file = await ctx.media.readBytes(item.id, { maxBytes: MAX_MEDIA_BYTES });
		const result = await requestAlt(ctx.http!, settings.apiKey!, {
			model: settings.model,
			image: { type: "base64", media_type: file.mimeType, data: bytesToBase64(file.bytes) },
			locale: settings.mediaLanguage,
			filename: item.filename,
		});
		if (!result.ok) return { ...base, alt: "", status: "error", message: result.message };
		await ctx.media.updateMetadata(item.id, { alt: result.alt });
		return { ...base, alt: result.alt, status: "generated" };
	} catch (error) {
		return { ...base, alt: "", status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}
