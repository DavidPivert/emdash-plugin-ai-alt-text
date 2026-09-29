/**
 * Alt text from Claude's vision models over the Messages API.
 *
 * Sandboxed plugins reach the network only through `ctx.http.fetch`, which is
 * why this calls the HTTP API directly instead of using `@anthropic-ai/sdk`.
 * The image is passed by URL: Anthropic downloads it, so nothing heavy is
 * encoded inside the sandbox (50 ms CPU budget per invocation).
 */

export const API_URL = "https://api.anthropic.com/v1/messages";
export const MAX_ALT_LENGTH = 125;

export const MODELS = ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;
export type Model = (typeof MODELS)[number];
export const DEFAULT_MODEL: Model = "claude-haiku-4-5";

export function resolveModel(value: unknown): Model {
	return MODELS.includes(value as Model) ? (value as Model) : DEFAULT_MODEL;
}

const SYSTEM_PROMPT = [
	"You write alternative text (the HTML alt attribute) for images on a website, for people who use screen readers.",
	`Describe what the image shows in one short, factual sentence of at most ${MAX_ALT_LENGTH} characters.`,
	'Do not start with "Image of", "Photo of", "Picture of" or their equivalent in the requested language.',
	"Do not identify real people by name.",
	"Reply with the alt text only, without quotes.",
].join(" ");

export interface AltRequest {
	model: Model;
	imageUrl: string;
	/** BCP 47 tag of the entry, e.g. `fr` or `en-GB`. */
	locale: string;
	/** Optional context: the entry title and the field holding the image. */
	entryTitle?: string;
	field?: string;
}

export function languageName(locale: string): string {
	const tag = locale.trim() || "en";
	try {
		const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
		if (name && name !== tag) return `${name} (${tag})`;
	} catch {
		// Invalid tag or no Intl data: fall back to the tag itself.
	}
	return tag;
}

export function buildRequest(input: AltRequest): { headers: Record<string, string>; body: Record<string, unknown> } {
	const context = input.entryTitle
		? ` It illustrates the entry "${input.entryTitle.slice(0, 200)}"${input.field ? ` (field "${input.field}")` : ""}.`
		: "";
	const body: Record<string, unknown> = {
		model: input.model,
		max_tokens: 300,
		system: SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", source: { type: "url", url: input.imageUrl } },
					{ type: "text", text: `Write the alt text for this image in ${languageName(input.locale)}.${context}` },
				],
			},
		],
	};
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (input.model !== "claude-haiku-4-5") {
		// Opus 5.5 and Sonnet 5.5 always think: leave room for it, keep it short,
		// and let the API retry on another model if a safety classifier declines.
		body.max_tokens = 2048;
		body.output_config = { effort: "low" };
		body.fallbacks = "default";
		headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
	}
	return { headers, body };
}

export function cleanAlt(raw: string): string {
	let alt = raw.trim().replace(/\s+/g, " ");
	alt = alt.replace(/^(alt(\s*text)?\s*:\s*)/i, "").trim();
	alt = alt.replace(/^["'«»“”‘’\s]+|["'«»“”‘’\s]+$/g, "").trim();
	if (Array.from(alt).length > MAX_ALT_LENGTH) {
		alt = Array.from(alt).slice(0, MAX_ALT_LENGTH).join("").replace(/\s+\S*$/, "").trim();
	}
	return alt;
}

export type AltResult =
	| { ok: true; alt: string }
	| { ok: false; reason: "refused" | "empty" | "error"; message: string };

interface MessagesResponse {
	stop_reason?: string;
	content?: Array<{ type: string; text?: string }>;
	error?: { type?: string; message?: string };
}

export function parseResponse(status: number, payload: unknown): AltResult {
	const data = (payload ?? {}) as MessagesResponse;
	if (status >= 400) {
		const type = data.error?.type ?? "http_error";
		return { ok: false, reason: "error", message: `Anthropic API ${status} ${type}: ${data.error?.message ?? ""}`.trim() };
	}
	if (data.stop_reason === "refusal") {
		return { ok: false, reason: "refused", message: "Claude declined to describe this image" };
	}
	const text = (data.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
	const alt = cleanAlt(text);
	return alt ? { ok: true, alt } : { ok: false, reason: "empty", message: "Claude returned no text" };
}

export interface HttpFetcher {
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

export async function requestAlt(http: HttpFetcher, apiKey: string, input: AltRequest): Promise<AltResult> {
	const { headers, body } = buildRequest(input);
	const response = await http.fetch(API_URL, {
		method: "POST",
		headers: { ...headers, "x-api-key": apiKey },
		body: JSON.stringify(body),
	});
	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}
	return parseResponse(response.status, payload);
}
