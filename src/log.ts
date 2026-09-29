import type { PluginContext } from "emdash/plugin";

import type { Model } from "./claude";

export interface AltLogEntry {
	collection: string;
	contentId: string;
	field: string;
	locale: string;
	alt: string;
	status: "generated" | "copied" | "skipped" | "error";
	/** What was written: the media library item or the entry's field. */
	target: "media" | "field";
	/** How Claude wrote it: translating existing alt text, or describing the image. */
	from?: "translation" | "description";
	message?: string;
	model: Model;
	at: string;
}

/** One host call for the whole batch. Never throws. */
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
