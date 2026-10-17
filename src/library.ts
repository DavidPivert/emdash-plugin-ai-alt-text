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
 *
 * On Cloudflare, reading bytes needs `@emdash-cms/cloudflare` 1.3.0 or later
 * (emdash#3646); earlier versions fail every read, which is logged.
 */
export const MAX_MEDIA_BYTES = 3 * 1024 * 1024;

/** Host calls per image: read bytes, Claude, save alt text. */
export const CALLS_PER_MEDIA_ITEM = 3;

export type LibraryItem = Pick<MediaItem, "id" | "filename" | "mimeType" | "size" | "alt">;

export function needsAlt(item: Pick<MediaItem, "id" | "alt" | "mimeType">): boolean {
	return !item.alt?.trim() && isSupportedImage({ id: item.id, mimeType: item.mimeType });
}

export interface DescribeOptions {
	/**
	 * Read the item again just before saving, and keep alt text a person added
	 * while Claude was writing (an upload hook runs while the uploader may
	 * already be typing it). One more host call.
	 */
	recheck?: boolean;
}

export async function describeMediaItem(
	ctx: PluginContext,
	settings: Settings,
	item: LibraryItem,
	budget: Budget,
	options: DescribeOptions = {},
): Promise<AltLogEntry> {
	const base = {
		collection: "media",
		contentId: item.id,
		field: item.filename,
		locale: settings.mediaLanguage,
		model: settings.model,
		target: "media" as const,
		from: "description" as const,
		at: new Date().toISOString(),
	};
	if (!needsAlt(item)) return { ...base, alt: item.alt ?? "", status: "skipped", message: "Already has alt text or unsupported format" };
	if (item.size !== null && item.size > MAX_MEDIA_BYTES) {
		return { ...base, alt: "", status: "skipped", message: "Too large to read in the sandbox; described when an entry uses it" };
	}
	const calls = CALLS_PER_MEDIA_ITEM + (options.recheck ? 1 : 0);
	if (!ctx.media?.readBytes || !ctx.media.updateMetadata || !budget.take(calls)) {
		return { ...base, alt: "", status: "skipped", message: "No budget left in this request" };
	}
	try {
		let file: { bytes: Uint8Array; mimeType: string };
		try {
			file = await ctx.media.readBytes(item.id, { maxBytes: MAX_MEDIA_BYTES });
		} catch (error) {
			return { ...base, alt: "", ...readFailure(error) };
		}
		const result = await requestAlt(ctx.http!, settings.apiKey!, {
			model: settings.model,
			image: { type: "base64", media_type: file.mimeType, data: bytesToBase64(file.bytes) },
			locale: settings.mediaLanguage,
			filename: item.filename,
		});
		if (!result.ok) return { ...base, alt: "", status: "error", message: result.message };
		if (options.recheck) {
			const current = await ctx.media.get(item.id);
			if (!current) return { ...base, alt: "", status: "skipped", message: "Deleted while Claude was writing" };
			if (current.alt?.trim()) return { ...base, alt: current.alt, status: "skipped", message: "Alt text was added while Claude was writing; kept" };
		}
		await ctx.media.updateMetadata(item.id, { alt: result.alt });
		return { ...base, alt: result.alt, status: "generated" };
	} catch (error) {
		return { ...base, alt: "", status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

/** Explains the read failures a site owner can act on. */
function readFailure(error: unknown): Pick<AltLogEntry, "status" | "message"> {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof RangeError || /exceeds the requested/i.test(message)) {
		return { status: "skipped", message: "Too large to read in the sandbox; described when an entry uses it" };
	}
	if (/storage is not configured/i.test(message)) {
		return {
			status: "error",
			message: "This EmDash version cannot read media files from plugins on Cloudflare: update @emdash-cms/cloudflare to 1.3.0 or later",
		};
	}
	return { status: "error", message };
}
