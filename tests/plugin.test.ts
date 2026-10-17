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
type ImageSource = { type: string; url?: string; media_type?: string; data?: string };
type SentRequest = {
	apiKey: string | undefined;
	body: { model: string; messages: Array<{ content: Array<{ type: string; text?: string; source?: ImageSource }> }> };
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
const sourceOf = (request: SentRequest) => request.body.messages[0]!.content[0]!.source;

/** A distinct JPEG for each call, so EmDash does not deduplicate uploads. */
function jpeg(variant = 0): Uint8Array {
	const bytes = JPEG.slice();
	bytes[5] = variant;
	return bytes;
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function upload(runtime: PluginRuntimeTestHost, filename: string, extra: { alt?: string; variant?: number; contentType?: string; bytes?: Uint8Array } = {}) {
	const result = await runtime.actions.media.upload({
		filename,
		base64: base64(extra.bytes ?? jpeg(extra.variant)),
		contentType: extra.contentType ?? "image/jpeg",
		...(extra.alt ? { alt: extra.alt } : {}),
	});
	if (!result.success) throw new Error(result.error.message);
	return result.data.item.id;
}

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

describe("new images", () => {
	it("are described on upload, in the media library language, from their bytes", async () => {
		const runtime = await setup();
		await runtime.http.respond(API, claudeSays("Pochette de Decimate, portrait sur fond turquoise"));

		const id = await upload(runtime, "decimate-cover.jpg");
		await settle(runtime, 1);

		expect((await mediaItem(runtime, id)).alt).toBe("Pochette de Decimate, portrait sur fond turquoise");
		const [request] = sent(runtime);
		expect(sourceOf(request!)).toEqual({ type: "base64", media_type: "image/jpeg", data: base64(jpeg()) });
		expect(promptOf(request!)).toContain("Write the alt text for this image in French (fr)");
		expect(promptOf(request!)).toContain('The file is named "decimate-cover.jpg"');
		const [entry] = await runtime.inspect.storage.list("alt_log");
		expect(entry!.data).toMatchObject({ collection: "media", contentId: id, status: "generated", target: "media", locale: "fr" });
		expect((await runtime.admin.loadWidget("activity")).blocks).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "context", text: expect.stringContaining("(media library, fr,") })]),
		);
	});

	it("keep the alt text given with the upload", async () => {
		const runtime = await setup();

		const id = await upload(runtime, "decimate.jpg", { alt: "Pochette écrite à la main" });
		await settle(runtime);

		expect(runtime.http.requests()).toEqual([]);
		expect((await mediaItem(runtime, id)).alt).toBe("Pochette écrite à la main");
	});

	it("are left alone when description on upload is off", async () => {
		const runtime = await setup({ apiKey: API_KEY, onUpload: false });

		const id = await upload(runtime, "decimate.jpg");
		await settle(runtime);

		expect(runtime.http.requests()).toEqual([]);
		expect((await mediaItem(runtime, id)).alt ?? null).toBeNull();
		const page = await runtime.admin.loadPage("/audit");
		expect(page.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "fields", fields: expect.arrayContaining([{ label: "New images", value: "Off" }]) }),
			]),
		);
	});

	it("are uploaded anyway when Claude fails", async () => {
		const runtime = await setup();
		await runtime.http.respond(API, claudeSays("Overloaded", 529));

		const id = await upload(runtime, "decimate.jpg");
		await settle(runtime, 1);

		expect((await mediaItem(runtime, id)).alt ?? null).toBeNull();
		const [entry] = await runtime.inspect.storage.list("alt_log");
		expect(entry!.data).toMatchObject({ status: "error", message: expect.stringContaining("529") });
	});

	it("are not read when Claude cannot take their format", async () => {
		const runtime = await setup();

		await upload(runtime, "booklet.pdf", { contentType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 test") });
		await settle(runtime);

		expect(runtime.http.requests()).toEqual([]);
		expect(await logCount(runtime)).toBe(0);
	});
});

describe("entries in another language", () => {
	it("get the media library alt text translated into their language, without touching the media library", async () => {
		const runtime = await setup();
		const image = await libraryImage(runtime, "decimate.jpg", "Pochette de Decimate");
		await runtime.http.respond(API, claudeSays("Decimate cover"));

		const item = await create(runtime, { title: "Decimate", cover: image.value() }, "en");
		await settle(runtime, 1);

		expect((await published(runtime, item.id)).cover?.alt).toBe("Decimate cover");
		expect((await mediaItem(runtime, image.id)).alt).toBe("Pochette de Decimate");
		const prompt = promptOf(sent(runtime)[0]!);
		expect(prompt).toContain("Translate this alt text from French (fr) into English (en)");
		expect(prompt).toContain("<alt>Pochette de Decimate</alt>");
		const [entry] = await runtime.inspect.storage.list("alt_log");
		expect(entry!.data).toMatchObject({ status: "generated", from: "translation", locale: "en" });
	});

	it("get the alt text of the entry they translate translated, when a person wrote one", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		const image = await libraryImage(runtime, "decimate.jpg", "Pochette de Decimate");
		const french = await create(runtime, { title: "Decimate", cover: image.value({ alt: "Maeta sur la pochette de Decimate" }) }, "fr");
		await settle(runtime);
		await configure(runtime, { apiKey: API_KEY });
		await runtime.http.respond(API, claudeSays("Maeta on the Decimate cover"));

		const english = await create(runtime, { title: "Decimate", cover: image.value({ alt: "Maeta sur la pochette de Decimate" }) }, "en", french.id);
		await settle(runtime, 1);

		expect((await published(runtime, english.id)).cover?.alt).toBe("Maeta on the Decimate cover");
		expect(promptOf(sent(runtime)[0]!)).toContain("<alt>Maeta sur la pochette de Decimate</alt>");
	});

	it("get a description in their language when the image has no alt text anywhere", async () => {
		const runtime = await setup();
		const image = await libraryImage(runtime, "decimate.jpg");
		await runtime.http.respond(API, claudeSays("Portrait on a turquoise background"));

		const item = await create(runtime, { title: "Decimate", cover: image.value() }, "en");
		await settle(runtime, 1);

		expect((await published(runtime, item.id)).cover?.alt).toBe("Portrait on a turquoise background");
		expect((await mediaItem(runtime, image.id)).alt ?? null).toBeNull();
		const prompt = promptOf(sent(runtime)[0]!);
		expect(prompt).toContain("Write the alt text for this image in English (en)");
		expect(prompt).not.toContain("<alt>");
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

	it("keeps saves and the admin page working when the stored key can no longer be decrypted", async () => {
		const runtime = await setup();
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", `emdash_enc_v1_${"B".repeat(42)}A`);
		const image = await libraryImage(runtime, "decimate.jpg");

		const item = await create(runtime, { title: "Decimate", cover: image.value() }, "fr");
		await settle(runtime);

		expect(runtime.http.requests()).toEqual([]);
		expect((await published(runtime, item.id)).title).toBe("Decimate");
		const page = await runtime.admin.loadPage("/audit");
		expect(page.blocks).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "banner", title: "Your Anthropic API key cannot be read" })]),
		);
	});

	it("stores the API key encrypted", async () => {
		const runtime = await setup();
		expect(JSON.stringify(await runtime.inspect.settings.raw<unknown>("apiKey"))).not.toContain(API_KEY);
	});
});

describe("admin", () => {
	it("warns without a key and offers the media library and the collections", async () => {
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

	it("finds media library images without alt text and describes them two at a time", async () => {
		const runtime = await setup();
		const images = [];
		for (const [index, name] of ["one.jpg", "two.jpg", "three.jpg"].entries()) {
			images.push((await runtime.fixtures.media({ filename: name, mimeType: "image/jpeg", bytes: jpeg(index) })).id);
		}
		await runtime.fixtures.media({ filename: "done.jpg", mimeType: "image/jpeg", bytes: jpeg(9), alt: "Déjà décrite" });

		const scan = await runtime.admin.act("/audit", "media-scan", { value: "" });
		const rows = (blocks: Array<{ type: string }>) =>
			(blocks.find((block) => block.type === "table") as unknown as { rows: Array<{ file: string }> }).rows.map((row) => row.file);
		expect(rows(scan.blocks).sort()).toEqual(["one.jpg", "three.jpg", "two.jpg"]);
		expect(scan.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "actions", elements: [expect.objectContaining({ action_id: "media-describe", label: "Describe the next 2" })] }),
			]),
		);

		await runtime.http.respond(API, claudeSays("Première image"));
		await runtime.http.respond(API, claudeSays("Deuxième image"));
		const described = await runtime.admin.act("/audit", "media-describe", { value: "|" });

		expect(runtime.http.requests()).toHaveLength(2);
		const alts = await Promise.all(images.map(async (id) => (await mediaItem(runtime, id)).alt ?? null));
		expect(alts.filter(Boolean).sort()).toEqual(["Deuxième image", "Première image"]);
		expect(rows(described.blocks)).toHaveLength(1);
		expect(described.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "section", text: "2 alt text(s) written." })]));
		expect(described.toast).toMatchObject({ type: "success" });
	});

	it("describes one media library image from its row, and leaves images that got alt text since", async () => {
		const runtime = await setup();
		const { id } = await runtime.fixtures.media({ filename: "one.jpg", mimeType: "image/jpeg", bytes: jpeg(1) });
		await runtime.http.respond(API, claudeSays("Une image"));

		await runtime.admin.act("/audit", "media-describe", { value: `|${id}` });
		expect((await mediaItem(runtime, id)).alt).toBe("Une image");

		const again = await runtime.admin.act("/audit", "media-describe", { value: `|${id}` });
		expect(runtime.http.requests()).toHaveLength(1);
		expect(again.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: "context", text: "This image already has alt text." })]));
	});

	it("leaves media library images too large for the sandbox to the entries that use them", async () => {
		const runtime = await setup();
		const big = new Uint8Array(3 * 1024 * 1024 + 1);
		big.set(JPEG.subarray(0, 4));
		const { id } = await runtime.fixtures.media({ filename: "poster.jpg", mimeType: "image/jpeg", bytes: big });

		const scan = await runtime.admin.act("/audit", "media-scan", { value: "" });
		expect(scan.blocks.some((block) => block.type === "actions")).toBe(false);
		const described = await runtime.admin.act("/audit", "media-describe", { value: `|${id}` });

		expect(runtime.http.requests()).toEqual([]);
		expect(described.blocks).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "context", text: expect.stringContaining("Too large to read in the sandbox") })]),
		);
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
