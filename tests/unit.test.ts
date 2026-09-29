import { describe, expect, it } from "vitest";

import { buildRequest, cleanAlt, languageName, parseResponse, resolveModel } from "../src/claude";
import { findMediaFields, isPrivateUrl, isSupportedImage, publicImageUrl } from "../src/media";

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

	it("treats local development hosts as unreachable", () => {
		expect(isPrivateUrl("http://localhost:4321/a.png")).toBe(true);
		expect(isPrivateUrl("https://site.test/a.png")).toBe(true);
		expect(isPrivateUrl("https://example.com/a.png")).toBe(false);
		expect(isPrivateUrl("not a url")).toBe(true);
	});
});

describe("Claude request", () => {
	const base = { imageUrl: "https://example.com/a.jpg", locale: "fr", entryTitle: "Decimate", field: "cover" } as const;

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
	});
});
