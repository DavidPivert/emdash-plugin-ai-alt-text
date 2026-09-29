/**
 * Finding image values in entry data and building a URL Claude can fetch.
 *
 * An EmDash image field stores an object such as
 * `{ id, src?, alt?, width?, height?, provider?, meta?: { storageKey } }`.
 * Setting `alt` on that object and saving the entry is enough to persist it.
 */

export interface MediaValue {
	id?: string;
	src?: string;
	alt?: string;
	mimeType?: string;
	meta?: Record<string, unknown> & { storageKey?: string; mimeType?: string };
	[key: string]: unknown;
}

export interface MediaFieldHit {
	/** Field path for logs and the audit table: `cover` or `gallery[2]`. */
	field: string;
	value: MediaValue;
}

/** Formats the Claude API accepts. Anything else (SVG, AVIF, HEIC, video) is skipped. */
const SUPPORTED_EXTENSION = /\.(jpe?g|png|gif|webp)(\?|#|$)/i;
const SUPPORTED_MIME = /^image\/(jpeg|png|gif|webp)$/i;
const ANY_EXTENSION = /\.([a-z0-9]{2,5})(\?|#|$)/i;

export function isMediaValue(value: unknown): value is MediaValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	const hasId = typeof v.id === "string" && v.id.length > 0;
	const hasSrc = typeof v.src === "string" && v.src.length > 0;
	const meta = v.meta as Record<string, unknown> | undefined;
	const hasKey = !!meta && typeof meta.storageKey === "string" && meta.storageKey.length > 0;
	return hasId && (hasSrc || hasKey);
}

export function hasAlt(value: MediaValue): boolean {
	return typeof value.alt === "string" && value.alt.trim().length > 0;
}

/** True when the image is in a format Claude can read. Unknown formats are given a chance. */
export function isSupportedImage(value: MediaValue): boolean {
	const mime = value.mimeType ?? value.meta?.mimeType;
	if (typeof mime === "string" && mime) return SUPPORTED_MIME.test(mime);
	const path = value.src ?? value.meta?.storageKey ?? "";
	if (SUPPORTED_EXTENSION.test(path)) return true;
	return !ANY_EXTENSION.test(path);
}

/** Top-level image fields and images inside top-level arrays (galleries, repeaters). */
export function findMediaFields(data: Record<string, unknown>): MediaFieldHit[] {
	const hits: MediaFieldHit[] = [];
	for (const [field, value] of Object.entries(data)) {
		if (isMediaValue(value)) {
			hits.push({ field, value });
		} else if (Array.isArray(value)) {
			value.forEach((item, index) => {
				if (isMediaValue(item)) hits.push({ field: `${field}[${index}]`, value: item });
			});
		}
	}
	return hits;
}

/**
 * Absolute URL Claude's servers can download. Claude fetches the image itself,
 * so the site (or the external host) must be publicly reachable.
 */
export function publicImageUrl(value: MediaValue, siteUrl: string): string | null {
	const base = siteUrl.replace(/\/+$/, "");
	if (typeof value.src === "string" && /^https?:\/\//i.test(value.src)) return value.src;
	if (!base) return null;
	if (typeof value.src === "string" && value.src.startsWith("/")) return base + value.src;
	const key = value.meta?.storageKey;
	if (typeof key === "string" && key) {
		return `${base}/_emdash/api/media/file/${key.split("/").map(encodeURIComponent).join("/")}`;
	}
	return null;
}

/** True for hosts Claude cannot reach (local development). */
export function isPrivateUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return (
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host.endsWith(".test") ||
			host === "127.0.0.1" ||
			host === "[::1]"
		);
	} catch {
		return true;
	}
}
