import { describe, expect, it } from "vitest";

import type { PluginContext } from "emdash/plugin";

import { buildRequest, cleanAlt, languageName, lengthLimit, parseResponse, resolveModel } from "../src/claude";
import { decide, referenceFor } from "../src/entries";
import { describeMediaItem, type LibraryItem, MAX_MEDIA_BYTES, needsAlt } from "../src/library";
import { bytesToBase64, findMediaFields, isPrivateUrl, isSupportedImage, publicImageUrl, sameLanguage, valueAtPath } from "../src/media";
import { Budget, NON_SECRET_SETTING_PREFIXES, type Settings } from "../src/settings";
import manifest from "../emdash-plugin.jsonc?raw";

describe("media helpers", () => {
	const cover = { id: "m1", src: "/_emdash/api/media/file/a.jpg", meta: { storageKey: "a.jpg" } };

	it("finds top-level images and images in arrays, ignoring other objects", () => {
		const hits = findMediaFields({
			title: "Hello",
			cover,
			gallery: [cover, { id: "x" }, "text"],
			seo: { title: "not an image" },
		});
		expect(hits.map((hit) => hit.field)).toEqual(["cover", "gallery[0]"]);
	});

	it("builds a public URL from src, a root-relative src, or the storage key", () => {
		expect(publicImageUrl({ id: "1", src: "https://cdn.example.org/a.png" }, "https://site.test")).toBe(
			"https://cdn.example.org/a.png",
		);
		expect(publicImageUrl({ id: "1", src: "/media/a.png" }, "https://example.com/")).toBe("https://example.com/media/a.png");
		expect(publicImageUrl({ id: "1", meta: { storageKey: "dir/a b.png" } }, "https://example.com")).toBe(
			"https://example.com/_emdash/api/media/file/dir/a%20b.png",
		);
		expect(publicImageUrl({ id: "1", meta: { storageKey: "a.png" } }, "")).toBeNull();
	});

	it("accepts only formats Claude reads", () => {
		expect(isSupportedImage({ id: "1", src: "/a.JPG" })).toBe(true);
		expect(isSupportedImage({ id: "1", src: "/a.webp?w=100" })).toBe(true);
		expect(isSupportedImage({ id: "1", src: "/a.svg" })).toBe(false);
		expect(isSupportedImage({ id: "1", src: "/a.avif" })).toBe(false);
		expect(isSupportedImage({ id: "1", src: "/clip.mp4" })).toBe(false);
		expect(isSupportedImage({ id: "1", mimeType: "image/heic", src: "/a" })).toBe(false);
		expect(isSupportedImage({ id: "1", src: "/media/file/abc" })).toBe(true);
	});

	it("encodes bytes in base64, with or without the native encoder", () => {
		const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, index) => (index * 31) % 256);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		expect(bytesToBase64(bytes)).toBe(btoa(binary));
		Object.defineProperty(bytes, "toBase64", { value: undefined });
		expect(bytesToBase64(bytes)).toBe(btoa(binary));
	});

	it("treats local development hosts as unreachable", () => {
		expect(isPrivateUrl("http://localhost:4321/a.png")).toBe(true);
		expect(isPrivateUrl("https://site.test/a.png")).toBe(true);
		expect(isPrivateUrl("https://example.com/a.png")).toBe(false);
		expect(isPrivateUrl("not a url")).toBe(true);
	});
});

describe("Claude request", () => {
	const base = { image: { type: "url", url: "https://example.com/a.jpg" }, locale: "fr", entryTitle: "Decimate", field: "cover" } as const;

	it("sends the image by URL and asks for the entry's language", () => {
		const { headers, body } = buildRequest({ ...base, model: "claude-haiku-4-5" });
		expect(body.model).toBe("claude-haiku-4-5");
		expect(body.max_tokens).toBe(300);
		expect(body).not.toHaveProperty("output_config");
		expect(headers).not.toHaveProperty("anthropic-beta");
		const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
		expect(content[0]).toEqual({ type: "image", source: { type: "url", url: "https://example.com/a.jpg" } });
		expect(content[1]!.text).toContain("French (fr)");
		expect(content[1]!.text).toContain('"Decimate"');
	});

	it("sends media library images as bytes, with their file name as a hint", () => {
		const { body } = buildRequest({
			model: "claude-haiku-4-5",
			image: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
			locale: "fr",
			filename: "decimate-cover.png",
		});
		const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
		expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
		expect(content[1]!.text).toContain('The file is named "decimate-cover.png", which may help but can be wrong.');
	});

	it("translates existing alt text when given one, checking it against the image", () => {
		const { body } = buildRequest({
			...base,
			locale: "en",
			model: "claude-haiku-4-5",
			reference: { text: "Pochette du single Decimate : portrait de Maeta", locale: "fr" },
		});
		const text = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[1]!.text as string;
		expect(text).toContain("Translate this alt text from French (fr) into English (en)");
		expect(text).toContain("<alt>Pochette du single Decimate : portrait de Maeta</alt>");
		expect(text).toContain("Keep every name it gives, people included");
		expect(text).toContain("Check it against the image only to correct something clearly wrong");
		expect(text).toContain("Stay under 125 characters");
		expect(body.system).toContain("Never identify a person from their appearance alone");
	});

	it("lets a translation be as long as the text it translates", () => {
		const long = "Maeta face à son hôte sur les fauteuils blancs du plateau du Joe Budden Network, micros en place, baie vitrée donnant sur la skyline";
		expect(lengthLimit({})).toBe(125);
		expect(lengthLimit({ reference: { text: "Un chat", locale: "fr" } })).toBe(125);
		expect(lengthLimit({ reference: { text: long, locale: "fr" } })).toBe(152);
		const { body } = buildRequest({ ...base, locale: "en", model: "claude-haiku-4-5", reference: { text: long, locale: "fr" } });
		expect((body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[1]!.text).toContain("Stay under 152 characters");
		const english = "Maeta facing her host on the white armchairs of the Joe Budden Network set, microphones in place, bay window overlooking the skyline";
		expect(parseResponse(200, { stop_reason: "end_turn", content: [{ type: "text", text: english }] }, 152)).toEqual({ ok: true, alt: english });
	});

	it("gives thinking models room, low effort and refusal fallbacks", () => {
		const { headers, body } = buildRequest({ ...base, model: "claude-opus-5-5" });
		expect(body.max_tokens).toBe(2048);
		expect(body.output_config).toEqual({ effort: "low" });
		expect(body.fallbacks).toBe("default");
		expect(headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
	});

	it("falls back to the default model for unknown values", () => {
		expect(resolveModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
		expect(resolveModel("gpt-4")).toBe("claude-haiku-4-5");
		expect(resolveModel(undefined)).toBe("claude-haiku-4-5");
	});

	it("names languages from BCP 47 tags", () => {
		expect(languageName("en-GB")).toContain("en-GB");
		expect(languageName("")).toContain("en");
	});
});

describe("Claude response", () => {
	it("returns cleaned text, skipping thinking blocks", () => {
		const result = parseResponse(200, {
			stop_reason: "end_turn",
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "text", text: ' "Pochette de l’album Decimate, fond rouge." ' },
			],
		});
		expect(result).toEqual({ ok: true, alt: "Pochette de l’album Decimate, fond rouge." });
	});

	it("reports refusals, empty answers and HTTP errors without throwing", () => {
		expect(parseResponse(200, { stop_reason: "refusal", content: [] })).toMatchObject({ ok: false, reason: "refused" });
		expect(parseResponse(200, { stop_reason: "end_turn", content: [] })).toMatchObject({ ok: false, reason: "empty" });
		expect(parseResponse(401, { error: { type: "authentication_error", message: "invalid x-api-key" } })).toMatchObject({
			ok: false,
			reason: "error",
			message: expect.stringContaining("401 authentication_error"),
		});
		expect(parseResponse(529, null)).toMatchObject({ ok: false, reason: "error" });
	});

	it("keeps alt text short and unquoted", () => {
		expect(cleanAlt("Alt text: « Une scène »")).toBe("Une scène");
		const long = cleanAlt(`${"mot ".repeat(60)}fin`);
		expect(Array.from(long).length).toBeLessThanOrEqual(125);
		expect(long.endsWith(" ")).toBe(false);
		// Cut on a word, without a dangling "and".
		expect(
			cleanAlt("Music production studio with two people working at keyboards and equipment under industrial ceiling with hanging cables and lamps"),
		).toBe("Music production studio with two people working at keyboards and equipment under industrial ceiling with hanging cables");
		// Cut on a clause when one ends past half the length.
		expect(
			cleanAlt("Studio de production musical avec deux personnes aux claviers et aux machines, sous un plafond industriel où pendent des câbles et des lampes"),
		).toBe("Studio de production musical avec deux personnes aux claviers et aux machines");
	});
});

describe("language and path helpers", () => {
	it("compares primary language subtags", () => {
		expect(sameLanguage("fr", "fr-CA")).toBe(true);
		expect(sameLanguage("en-GB", "EN")).toBe(true);
		expect(sameLanguage("fr", "en")).toBe(false);
		expect(sameLanguage("", "")).toBe(false);
	});

	it("reads image values by field path", () => {
		const img = { id: "m", meta: { storageKey: "k.jpg" }, alt: "x" };
		expect(valueAtPath({ cover: img }, "cover")).toBe(img);
		expect(valueAtPath({ gallery: [{}, img] }, "gallery[1]")).toBe(img);
		expect(valueAtPath({ cover: "text" }, "cover")).toBeUndefined();
	});

});

describe("decide", () => {
	const same = { sameLanguage: true } as const;
	const other = { sameLanguage: false } as const;

	it("leaves entries in the media library language to the media library", () => {
		expect(decide({ ...same, phase: "before-save", fieldAlt: undefined })).toBe("needs-media-alt");
		expect(decide({ ...same, phase: "before-save", fieldAlt: undefined, mediaAlt: "Chat" })).toBe("skip");
		expect(decide({ ...same, phase: "before-save", fieldAlt: "Texte" })).toBe("skip");
		expect(decide({ ...same, phase: "after-save", fieldAlt: "Texte" })).toBe("skip");
	});

	it("describes images that have no alt text anywhere", () => {
		expect(decide({ ...same, phase: "before-save", fieldAlt: "", mediaAlt: null })).toBe("describe");
		expect(decide({ ...same, phase: "after-save", fieldAlt: undefined, mediaAlt: null })).toBe("describe");
	});

	it("copies media library alt text into a stale empty field outside a save", () => {
		expect(decide({ ...same, phase: "after-save", fieldAlt: undefined, mediaAlt: "Chat" })).toBe("inherit");
	});

	it("translates inherited or copied alt text in other languages", () => {
		expect(decide({ ...other, phase: "before-save", fieldAlt: undefined })).toBe("needs-media-alt");
		expect(decide({ ...other, phase: "before-save", fieldAlt: undefined, mediaAlt: "Un chat" })).toBe("translate");
		expect(decide({ ...other, phase: "after-save", fieldAlt: undefined, mediaAlt: null })).toBe("translate");
		expect(decide({ ...other, phase: "after-save", fieldAlt: "Un chat" })).toBe("needs-media-alt");
		expect(decide({ ...other, phase: "after-save", fieldAlt: " un  CHAT ", mediaAlt: "Un chat" })).toBe("translate");
		expect(decide({ ...other, phase: "after-save", fieldAlt: "Un chat", mediaAlt: "Autre" })).toBe("needs-source-alt");
		expect(decide({ ...other, phase: "after-save", fieldAlt: "Un chat", mediaAlt: "Autre", sourceAlt: "Un chat" })).toBe("translate");
	});

	it("keeps alt text a person wrote for the entry", () => {
		expect(decide({ ...other, phase: "after-save", fieldAlt: "A cat", mediaAlt: "Un chat", sourceAlt: null })).toBe("skip");
		expect(decide({ ...other, phase: "after-save", fieldAlt: "A cat", mediaAlt: null, sourceAlt: "Un chat" })).toBe("skip");
	});
});

describe("referenceFor", () => {
	const other = { sameLanguage: false, phase: "after-save" } as const;

	it("starts from the media library text, inherited or about to be", () => {
		expect(referenceFor({ ...other, fieldAlt: undefined, mediaAlt: "Un chat" }, "fr", "fr")).toEqual({ text: "Un chat", locale: "fr" });
		expect(referenceFor({ ...other, fieldAlt: "Un chat ", mediaAlt: "un chat" }, "fr", "de")).toEqual({ text: "Un chat", locale: "fr" });
	});

	it("starts from the translated entry's text, in that entry's language", () => {
		expect(referenceFor({ ...other, fieldAlt: "Eine Katze", mediaAlt: "Un chat", sourceAlt: "Eine Katze" }, "fr", "de")).toEqual({
			text: "Eine Katze",
			locale: "de",
		});
	});

	it("has nothing to start from when the image has no alt text", () => {
		expect(referenceFor({ ...other, fieldAlt: undefined, mediaAlt: null }, "fr", "fr")).toBeUndefined();
	});
});

describe("settings fallback", () => {
	it("reaches every setting but the API key", () => {
		const schema = manifest.slice(manifest.indexOf("settingsSchema"));
		const keys = [...schema.matchAll(/^\t{3}"?([a-zA-Z]+)"?\s*:\s*\{/gm)].map((match) => match[1]!);
		expect(keys).toContain("apiKey");
		for (const key of keys) {
			expect(NON_SECRET_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix)), key).toBe(key !== "apiKey");
		}
	});
});

describe("describeMediaItem", () => {
	const settings: Settings = {
		apiKey: "sk-ant-test",
		apiKeyUnreadable: false,
		model: "claude-haiku-4-5",
		mediaLanguage: "fr",
		mediaLanguageFrom: "setting",
		onUpload: true,
		onSave: true,
		siteUrl: "https://example.com",
		collections: [],
	};
	const item: LibraryItem = { id: "m1", filename: "cover.jpg", mimeType: "image/jpeg", size: 14, alt: null };

	/** Just what describeMediaItem uses, with every call recorded. */
	function fakeContext(options: { readBytes?: () => Promise<unknown>; altAfterwards?: string | null; claude?: string } = {}) {
		const calls: string[] = [];
		const ctx = {
			media: {
				get: async () => {
					calls.push("get");
					return { ...item, alt: options.altAfterwards ?? null };
				},
				readBytes: async () => {
					calls.push("readBytes");
					return (options.readBytes ?? (async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" })))();
				},
				updateMetadata: async (_id: string, patch: { alt: string }) => {
					calls.push(`update:${patch.alt}`);
					return item;
				},
			},
			http: {
				fetch: async (_url: string, init?: RequestInit) => {
					calls.push(`claude:${JSON.parse(String(init?.body)).messages[0].content[0].source.data}`);
					return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: options.claude ?? "Une pochette" }] }));
				},
			},
		};
		return { ctx: ctx as unknown as PluginContext, calls };
	}

	it("reads the bytes, asks Claude and saves the alt text in three host calls", async () => {
		const { ctx, calls } = fakeContext();
		const budget = new Budget(3);
		expect(await describeMediaItem(ctx, settings, item, budget)).toMatchObject({ status: "generated", alt: "Une pochette", target: "media", locale: "fr" });
		expect(calls).toEqual(["readBytes", "claude:AQID", "update:Une pochette"]);
		expect(budget.left).toBe(0);
	});

	it("keeps alt text a person added while Claude was writing", async () => {
		const { ctx, calls } = fakeContext({ altAfterwards: "Écrite pendant ce temps" });
		const entry = await describeMediaItem(ctx, settings, item, new Budget(4), { recheck: true });
		expect(entry).toMatchObject({ status: "skipped", alt: "Écrite pendant ce temps" });
		expect(calls.some((call) => call.startsWith("update:"))).toBe(false);
	});

	it("checks again before saving only when asked, and within the budget", async () => {
		const { ctx, calls } = fakeContext();
		expect(await describeMediaItem(ctx, settings, item, new Budget(3), { recheck: true })).toMatchObject({ status: "skipped", message: "No budget left in this request" });
		expect(calls).toEqual([]);
		expect(await describeMediaItem(ctx, settings, item, new Budget(4), { recheck: true })).toMatchObject({ status: "generated" });
		expect(calls).toEqual(["readBytes", "claude:AQID", "get", "update:Une pochette"]);
	});

	it("says what to update when EmDash cannot read media files on Cloudflare", async () => {
		const { ctx } = fakeContext({ readBytes: async () => Promise.reject(new Error("Media storage is not configured")) });
		expect(await describeMediaItem(ctx, settings, item, new Budget(3))).toMatchObject({
			status: "error",
			message: expect.stringContaining("@emdash-cms/cloudflare to 1.3.0"),
		});
	});

	it("leaves images too large for the sandbox to the entries that use them", async () => {
		const { ctx, calls } = fakeContext({ readBytes: async () => Promise.reject(new RangeError("Media exceeds the requested 3145728-byte limit")) });
		expect(await describeMediaItem(ctx, settings, { ...item, size: null }, new Budget(3))).toMatchObject({ status: "skipped", message: expect.stringContaining("Too large") });
		expect(await describeMediaItem(ctx, settings, { ...item, size: MAX_MEDIA_BYTES + 1 }, new Budget(3))).toMatchObject({ status: "skipped" });
		expect(calls).toEqual(["readBytes"]);
	});

	it("only describes supported images without alt text", () => {
		expect(needsAlt(item)).toBe(true);
		expect(needsAlt({ ...item, alt: "  " })).toBe(true);
		expect(needsAlt({ ...item, alt: "Une pochette" })).toBe(false);
		expect(needsAlt({ ...item, mimeType: "image/svg+xml" })).toBe(false);
		expect(needsAlt({ ...item, mimeType: "application/pdf" })).toBe(false);
	});
});
