import type { PluginContext } from "emdash/plugin";

import { type Reference, requestAlt } from "./claude";
import type { AltLogEntry } from "./log";
import { findMediaFields, isPrivateUrl, isSupportedImage, type MediaValue, publicImageUrl, sameLanguage, valueAtPath } from "./media";
import type { Budget, Settings } from "./settings";

/**
 * Alt text for the images of one entry.
 *
 * EmDash fills an image field that has no alt text with the alt text of the
 * media library item, after the save hooks and before writing. So the media
 * library holds the alt text every entry inherits, in one language. This
 * module only acts where that falls short:
 *
 * - `describe`: the image has no alt text anywhere. Claude describes it in the
 *   media library language; the text goes to the media library item (so every
 *   entry inherits it) and to this field.
 * - `inherit`: the media library has alt text but the stored field is empty
 *   (the image got its alt text after the entry was saved): copy it.
 * - `translate`: the entry is in another language and its field holds, or is
 *   about to inherit, text in another language (from the media library, or
 *   copied from the entry it translates). Claude translates that text into the
 *   entry's language, checking it against the image, for this field only; with
 *   no text to start from, it describes the image in the entry's language.
 *
 * Alt text a person wrote for this entry is never replaced.
 */

export type Phase = "before-save" | "after-save";

export interface EntryInfo {
	collection: string;
	id: string;
	locale: string;
	title?: string;
	/** before-save runs before EmDash fills missing alt text; after-save and the admin see the stored data. */
	phase: Phase;
	/** Look up the entry this one translates, to spot alt text copied from it. */
	checkSource: boolean;
}

export type Action = "skip" | "inherit" | "describe" | "translate";

export interface DecisionInput {
	fieldAlt: string | undefined;
	sameLanguage: boolean;
	phase: Phase;
	/** Lazily read: undefined means not looked up, null means the media item has none. */
	mediaAlt?: string | null;
	sourceAlt?: string | null;
}

const normalized = (text: string | null | undefined) => (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Pure decision, given what is known. Returns `needs-…` when a lookup must
 * happen first.
 * - `inherit`: copy the media library alt text into the field (no Claude call).
 *   Needed outside a save: EmDash only fills empty fields while saving.
 */
export function decide(input: DecisionInput): Action | "needs-media-alt" | "needs-source-alt" {
	const fieldAlt = input.fieldAlt?.trim();
	if (!fieldAlt) {
		// Other languages too: the media library text is what gets translated.
		if (input.mediaAlt === undefined) return "needs-media-alt";
		if (!input.sameLanguage) return "translate";
		if (input.mediaAlt) return input.phase === "before-save" ? "skip" : "inherit";
		return "describe";
	}
	if (input.sameLanguage) return "skip";
	if (input.mediaAlt === undefined) return "needs-media-alt";
	if (input.mediaAlt && normalized(fieldAlt) === normalized(input.mediaAlt)) return "translate";
	if (input.sourceAlt === undefined) return "needs-source-alt";
	if (input.sourceAlt && normalized(fieldAlt) === normalized(input.sourceAlt)) return "translate";
	return "skip";
}

/**
 * The text a translation starts from: the field's inherited text, or the media
 * library text it is about to inherit. Its language is the media library's,
 * unless it came from the entry this one translates.
 */
export function referenceFor(input: DecisionInput, mediaLanguage: string, sourceLocale: string): Reference | undefined {
	const fieldAlt = input.fieldAlt?.trim();
	const text = fieldAlt || input.mediaAlt?.trim();
	if (!text) return undefined;
	const fromSource = !!fieldAlt && normalized(fieldAlt) !== normalized(input.mediaAlt) && normalized(fieldAlt) === normalized(input.sourceAlt);
	return { text, locale: fromSource ? sourceLocale : mediaLanguage };
}

export interface EntryResult {
	changed: number;
	remaining: number;
	log: AltLogEntry[];
}

export async function processEntry(
	ctx: PluginContext,
	settings: Settings,
	data: Record<string, unknown>,
	entry: EntryInfo,
	budget: Budget,
): Promise<EntryResult> {
	const at = new Date().toISOString();
	const log: AltLogEntry[] = [];
	const base = { collection: entry.collection, contentId: entry.id, model: settings.model, at };
	const same = sameLanguage(entry.locale, settings.mediaLanguage);
	let changed = 0;
	let remaining = 0;
	let sourceData: Record<string, unknown> | null | undefined;
	let sourceLocale = settings.mediaLanguage;

	const mediaAlt = async (value: MediaValue): Promise<string | null> => {
		if (value.provider !== "local" || !value.id || !ctx.media) return null;
		const item = await ctx.media.get(value.id);
		return item?.alt?.trim() || null;
	};
	const sourceAlt = async (field: string): Promise<string | null> => {
		if (sourceData === undefined) {
			sourceData = null;
			const translations = await ctx.content?.getTranslations?.(entry.collection, entry.id);
			const siblings = (translations?.translations ?? []).filter((t) => t.id !== entry.id);
			const source =
				siblings.find((t) => t.locale && sameLanguage(t.locale, settings.mediaLanguage)) ?? siblings[0];
			if (source && budget.take()) {
				sourceData = (await ctx.content?.get(entry.collection, source.id))?.data ?? null;
				if (source.locale) sourceLocale = source.locale;
			}
		}
		return (sourceData && valueAtPath(sourceData, field)?.alt?.trim()) || null;
	};

	for (const { field, value } of findMediaFields(data)) {
		if (!isSupportedImage(value)) continue;
		const url = publicImageUrl(value, settings.siteUrl);
		if (!url || isPrivateUrl(url)) {
			log.push({ ...base, field, locale: entry.locale, alt: "", status: "skipped", target: "field", message: "No public URL for this image" });
			continue;
		}

		const input: DecisionInput = { fieldAlt: typeof value.alt === "string" ? value.alt : undefined, sameLanguage: same, phase: entry.phase };
		let action = decide(input);
		let outOfBudget = false;
		while (action === "needs-media-alt" || action === "needs-source-alt") {
			if (action === "needs-source-alt" && !entry.checkSource) {
				input.sourceAlt = null;
			} else if (action === "needs-media-alt") {
				if (!budget.take()) { outOfBudget = true; break; }
				input.mediaAlt = await mediaAlt(value);
			} else {
				// The first lookup lists translations (one call; reading the source is reserved inside).
				if (sourceData === undefined && !budget.take()) { outOfBudget = true; break; }
				input.sourceAlt = await sourceAlt(field);
			}
			action = decide(input);
		}
		if (outOfBudget) { remaining++; continue; }
		if (action === "skip") continue;
		if (action === "inherit") {
			value.alt = input.mediaAlt!;
			changed++;
			log.push({ ...base, field, locale: settings.mediaLanguage, alt: value.alt, status: "copied", target: "field" });
			continue;
		}

		const writeMedia = action === "describe" && value.provider === "local" && !!value.id && !!ctx.media?.updateMetadata;
		if (!budget.take(writeMedia ? 2 : 1)) { remaining++; continue; }
		const locale = action === "describe" ? settings.mediaLanguage : entry.locale;
		const reference = action === "translate" ? referenceFor(input, settings.mediaLanguage, sourceLocale) : undefined;
		const from = reference ? "translation" : "description";
		try {
			const result = await requestAlt(ctx.http!, settings.apiKey!, {
				model: settings.model,
				image: { type: "url", url },
				locale,
				reference,
				entryTitle: entry.title,
				field,
			});
			if (!result.ok) {
				log.push({ ...base, field, locale, alt: "", status: "error", target: "field", from, message: result.message });
				ctx.log.warn("ai-alt-text: no alt text written", { collection: entry.collection, field, reason: result.message });
				continue;
			}
			value.alt = result.alt;
			changed++;
			log.push({ ...base, field, locale, alt: result.alt, status: "generated", target: writeMedia ? "media" : "field", from });
			if (writeMedia) await ctx.media!.updateMetadata!(value.id!, { alt: result.alt });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.push({ ...base, field, locale, alt: "", status: "error", target: "field", from, message });
			ctx.log.warn("ai-alt-text: no alt text written", { collection: entry.collection, field, reason: message });
		}
	}
	return { changed, remaining, log };
}
