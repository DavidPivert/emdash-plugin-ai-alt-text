import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const API = "https://api.anthropic.com/v1/messages";
const ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;
const API_KEY = "sk-ant-test-key";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

type ImageValue = { id?: string; alt?: string; provider?: string; meta?: { storageKey?: string } };
type SentRequest = {
	apiKey: string | undefined;
	body: { model: string; messages: Array<{ content: Array<{ type: string; text?: string; source?: { type: string; url?: string } }> }> };
};

function claudeSays(text: string, status = 200): Response {
	const body =
		status === 200
			? { stop_reason: "end_turn", content: [{ type: "text", text }] }
			: { type: "error", error: { type: "overloaded_error", message: text } };
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function setup(settings: Record<string, unknown> = { apiKey: API_KEY }): Promise<PluginRuntimeTestHost> {
	vi.stubEnv("EMDASH_ENCRYPTION_KEY", ENCRYPTION_KEY);
	host = await createPluginRuntimeTestHost({ site: { name: "Example", url: "https://example.com", locale: "fr" } });
	await host.fixtures.collection({
		slug: "albums",
		label: "Albums",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "cover", label: "Cover", type: "image" },
		],
	});
	await configure(host, settings);
	return host;
}

async function configure(runtime: PluginRuntimeTestHost, settings: Record<string, unknown>) {
	expect(await runtime.actions.plugin.updateSettings(settings)).toMatchObject({ success: true });
}

async function mediaItem(runtime: PluginRuntimeTestHost, id: string) {
	const result = (await runtime.inspect.media(id)) as unknown as { success: boolean; data: { item: { storageKey: string; alt?: string | null } } };
	return result.data.item;
}

/** A media library image, and the value an image field stores for it. */
async function libraryImage(runtime: PluginRuntimeTestHost, filename: string, alt?: string) {
	const { id } = await runtime.fixtures.media({ filename, mimeType: "image/jpeg", bytes: JPEG, ...(alt ? { alt } : {}) });
	const { storageKey } = await mediaItem(runtime, id);
	return { id, value: (extra: Partial<ImageValue> = {}) => ({ id, provider: "local", meta: { storageKey }, ...extra }) };
}

async function create(runtime: PluginRuntimeTestHost, data: Record<string, unknown>, locale: string, translationOf?: string) {
	const created = await runtime.actions.content.create("albums", { data, locale, ...(translationOf ? { translationOf } : {}) });
	if (!created.success) throw new Error(created.error.message);
	return created.data.item;
}

async function logCount(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.storage.list("alt_log")).length;
}

/** after-save work runs after the request returns: wait for the plugin's log, or give it time when nothing is expected. */
async function settle(runtime: PluginRuntimeTestHost, expectedLogs?: number) {
	if (expectedLogs === undefined) {
		await new Promise((resolve) => setTimeout(resolve, 400));
		return;
	}
	for (let attempt = 0; attempt < 60; attempt++) {
		if ((await logCount(runtime)) >= expectedLogs) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`expected ${expectedLogs} log entries`);
}

async function published(runtime: PluginRuntimeTestHost, id: string) {
	const result = await runtime.actions.content.publish("albums", id, {});
	if (!result.success) throw new Error(result.error.message);
	return result.data.item.data as { cover?: ImageValue; title?: string };
}

function sent(runtime: PluginRuntimeTestHost): SentRequest[] {
	return runtime.http.requests().map((request) => ({
		apiKey: request.headers["x-api-key"],
		body: JSON.parse(new TextDecoder().decode(request.body)) as SentRequest["body"],
	}));
}

const promptOf = (request: SentRequest) => request.body.messages[0]!.content[1]!.text ?? "";

describe("media library", () => {
	it("describes a new image on upload, in the site language, from its bytes", async () => {
		const runtime = await setup();
		await runtime.http.respond(API, claudeSays("Pochette de l’album Decimate, fond turquoise"));

		const upload = await runtime.actions.media.upload({ filename: "decimate.jpg", contentType: "image/jpeg", base64: "/9j/4AAQSkZJRgABAQ==" });
		if (!upload.success) throw new Error(upload.error.message);

		expect((await mediaItem(runtime, upload.data.item.id)).alt).toBe("Pochette de l’album Decimate, fond turquoise");
		const [request] = sent(runtime);
		expect(request!.apiKey).toBe(API_KEY);
		expect(request!.body.messages[0]!.content[0]!.source!.type).toBe("base64");
		expect(promptOf(request!)).toContain("French");
		expect(promptOf(request!)).toContain("decimate.jpg");
	});
});

describe("entries in the media library language", () => {
	it("inherit the media library alt text without calling Claude", async () => {
		const runtime = await setup();
		const image = await libraryImage(runtime, "decimate.jpg", "Pochette de Decimate");

		const item = await create(runtime, { title: "Decimate", cover: image.value() }, "fr");
		await settle(runtime);

		expect(runtime.http.requests()).toEqual([]);
		expect((await published(runtime, item.id)).cover?.alt).toBe("Pochette de Decimate");
	});

	it("get a description, stored in the media library too, when the image has none", async () => {
		const runtime = await setup();
		const image = await libraryImage(runtime, "decimate.jpg");
		await runtime.http.respond(API, claudeSays("Pochette de Decimate, portrait sur fond turquoise"));

		const item = await create(runtime, { title: "Decimate", cover: image.value() }, "fr");
		await settle(runtime, 1);

		expect((await published(runtime, item.id)).cover?.alt).toBe("Pochette de Decimate, portrait sur fond turquoise");
		expect((await mediaItem(runtime, image.id)).alt).toBe("Pochette de Decimate, portrait sur fond turquoise");
		const [request] = sent(runtime);
		expect(request!.body.messages[0]!.content[0]!.source).toEqual({
			type: "url",
			url: `https://example.com/_emdash/api/media/file/${(await mediaItem(runtime, image.id)).storageKey}`,
		});
	});

	it("get a description during the save when an existing entry gets an image without alt text", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		const item = await create(runtime, { title: "Decimate" }, "fr");
		await settle(runtime);
		await configure(runtime, { apiKey: API_KEY });
		const image = await libraryImage(runtime, "new.jpg");
		await runtime.http.respond(API, claudeSays("Nouvelle pochette"));

		const updated = await runtime.actions.content.update("albums", item.id, { data: { title: "Decimate", cover: image.value() } });
		if (!updated.success) throw new Error(updated.error.message);

		expect((await published(runtime, item.id)).cover?.alt).toBe("Nouvelle pochette");
		expect((await mediaItem(runtime, image.id)).alt).toBe("Nouvelle pochette");
	});
});

describe("entries in another language", () => {
	it("get alt text in their language instead of the inherited one, without touching the media library", async () => {
		const runtime = await setup();
		const image = await libraryImage(runtime, "decimate.jpg", "Pochette de Decimate");
		await runtime.http.respond(API, claudeSays("Decimate cover, portrait on a turquoise background"));

		const item = await create(runtime, { title: "Decimate", cover: image.value() }, "en");
		await settle(runtime, 1);

		expect((await published(runtime, item.id)).cover?.alt).toBe("Decimate cover, portrait on a turquoise background");
		expect((await mediaItem(runtime, image.id)).alt).toBe("Pochette de Decimate");
		expect(promptOf(sent(runtime)[0]!)).toContain("English");
	});

	it("replace alt text copied from the entry they translate", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		const image = await libraryImage(runtime, "decimate.jpg", "Pochette de Decimate");
		const french = await create(runtime, { title: "Decimate", cover: image.value({ alt: "Maeta sur la pochette de Decimate" }) }, "fr");
		await settle(runtime);
		await configure(runtime, { apiKey: API_KEY });
		await runtime.http.respond(API, claudeSays("Maeta on the Decimate cover"));

		const english = await create(runtime, { title: "Decimate", cover: image.value({ alt: "Maeta sur la pochette de Decimate" }) }, "en", french.id);
		await settle(runtime, 1);

		expect((await published(runtime, english.id)).cover?.alt).toBe("Maeta on the Decimate cover");
	});

	it("keep alt text a person wrote for them", async () => {
		const runtime = await setup();
		const image = await libraryImage(runtime, "decimate.jpg", "Pochette de Decimate");

		const item = await create(runtime, { title: "Decimate", cover: image.value({ alt: "Hand-written English alt text" }) }, "en");
		await settle(runtime);

		expect(runtime.http.requests()).toEqual([]);
		expect((await published(runtime, item.id)).cover?.alt).toBe("Hand-written English alt text");
	});
});

describe("safety", () => {
	it("saves the entry anyway when Claude fails", async () => {
		const runtime = await setup();
		const image = await libraryImage(runtime, "decimate.jpg");
		await runtime.http.respond(API, claudeSays("Overloaded", 529));

		const item = await create(runtime, { title: "Decimate", cover: image.value() }, "fr");
		await settle(runtime, 1);

		const [entry] = await runtime.inspect.storage.list("alt_log");
		expect(entry!.data).toMatchObject({ status: "error" });
		const data = await published(runtime, item.id);
		expect(data.title).toBe("Decimate");
		expect(data.cover?.alt).toBeUndefined();
		expect((await mediaItem(runtime, image.id)).alt ?? null).toBeNull();
	});

	it("does nothing without an API key", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		const image = await libraryImage(runtime, "decimate.jpg");
		await create(runtime, { title: "Decimate", cover: image.value() }, "en");
		await settle(runtime);
		expect(runtime.http.requests()).toEqual([]);
		expect(await logCount(runtime)).toBe(0);
	});

	it("stores the API key encrypted", async () => {
		const runtime = await setup();
		expect(JSON.stringify(await runtime.inspect.settings.raw<unknown>("apiKey"))).not.toContain(API_KEY);
	});
});

describe("admin", () => {
	it("warns without a key and offers the media library and collections", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		const page = await runtime.admin.loadPage("/audit");
		expect(page.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "banner", title: "No Anthropic API key" }),
				expect.objectContaining({ type: "section", accessory: expect.objectContaining({ action_id: "media-scan" }) }),
				expect.objectContaining({ type: "actions", elements: [expect.objectContaining({ action_id: "scan", value: "albums|" })] }),
			]),
		);
	});

	it("lists media library images without alt text and describes them", async () => {
		const runtime = await setup({ apiKey: API_KEY, onUpload: false });
		const image = await libraryImage(runtime, "no-alt.jpg");
		await libraryImage(runtime, "has-alt.jpg", "Déjà décrite");

		const scan = await runtime.admin.act("/audit", "media-scan", { value: "" });
		const table = scan.blocks.find((block) => block.type === "table") as unknown as { rows: Array<{ file: string; action: { value: unknown } }> };
		expect(table.rows.map((row) => row.file)).toEqual(["no-alt.jpg"]);

		await runtime.http.respond(API, claudeSays("Une image décrite"));
		const done = await runtime.admin.act("/audit", "media-describe", { value: table.rows[0]!.action.value });
		expect(done.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "fields", fields: [expect.objectContaining({ value: "Une image décrite" })] })]));
		expect((await mediaItem(runtime, image.id)).alt).toBe("Une image décrite");
	});

	it("completes an entry in another language from the admin", async () => {
		const runtime = await setup({ apiKey: API_KEY, onSave: false });
		const image = await libraryImage(runtime, "decimate.jpg", "Pochette de Decimate");
		// As stored in production: EmDash copied the media library (French) alt text into the field.
		const item = await create(runtime, { title: "Decimate", cover: image.value({ alt: "Pochette de Decimate" }) }, "en");
		await settle(runtime);

		const scan = await runtime.admin.act("/audit", "scan", { value: "albums|" });
		const table = scan.blocks.find((block) => block.type === "table") as unknown as {
			rows: Array<{ entry: string; locale: string; alt: string; action: { value: string } }>;
		};
		expect(table.rows).toEqual([expect.objectContaining({ entry: "Decimate", locale: "en", alt: "Pochette de Decimate" })]);

		await runtime.http.respond(API, claudeSays("Decimate cover"));
		await runtime.admin.act("/audit", "complete", { value: table.rows[0]!.action.value });
		expect((await published(runtime, item.id)).cover?.alt).toBe("Decimate cover");
	});

	it("shows recent activity in the dashboard widget", async () => {
		const runtime = await setup();
		expect((await runtime.admin.loadWidget("activity")).blocks).toEqual([expect.objectContaining({ type: "empty" })]);

		const image = await libraryImage(runtime, "decimate.jpg");
		await runtime.http.respond(API, claudeSays("Pochette rouge"));
		await create(runtime, { title: "Decimate", cover: image.value() }, "fr");
		await settle(runtime, 1);

		expect((await runtime.admin.loadWidget("activity")).blocks).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "stats", items: expect.arrayContaining([expect.objectContaining({ value: 1 })]) })]),
		);
	});
});
