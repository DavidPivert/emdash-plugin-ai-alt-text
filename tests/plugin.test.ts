import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const API = "https://api.anthropic.com/v1/messages";
const ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;
const API_KEY = "sk-ant-test-key";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

type ImageValue = { alt?: string };

function image(key: string, alt?: string) {
	return { id: `media-${key}`, src: `/_emdash/api/media/file/${key}`, meta: { storageKey: key }, ...(alt ? { alt } : {}) };
}

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
			{ slug: "back", label: "Back cover", type: "image" },
		],
	});
	await configure(host, settings);
	return host;
}

async function configure(runtime: PluginRuntimeTestHost, settings: Record<string, unknown>) {
	const updated = await runtime.actions.plugin.updateSettings(settings);
	expect(updated).toMatchObject({ success: true });
}

async function create(runtime: PluginRuntimeTestHost, data: Record<string, unknown>, locale?: string) {
	const created = await runtime.actions.content.create("albums", { data, ...(locale ? { locale } : {}) });
	if (!created.success) throw new Error(created.error.message);
	return created.data.item;
}

/** New entries get their alt text after the save (content:afterSave), so wait for the plugin's log. */
async function waitForLog(runtime: PluginRuntimeTestHost, count = 1) {
	for (let attempt = 0; attempt < 60; attempt++) {
		const entries = await runtime.inspect.storage.list("alt_log");
		if (entries.length >= count) return entries;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("the plugin never logged a result");
}

async function publishedData(runtime: PluginRuntimeTestHost, id: string) {
	const published = await runtime.actions.content.publish("albums", id, {});
	if (!published.success) throw new Error(published.error.message);
	return published.data.item.data as Record<string, unknown>;
}

function sentBodies(runtime: PluginRuntimeTestHost) {
	return runtime.http.requests().map((request) => ({
		apiKey: request.headers["x-api-key"],
		body: JSON.parse(new TextDecoder().decode(request.body)) as {
			model: string;
			messages: Array<{ content: Array<{ type: string; text?: string; source?: { url: string } }> }>;
		},
	}));
}

describe("new entries (content:afterSave)", () => {
	it("writes alt text in the entry's language, ready once published", async () => {
		const runtime = await setup();
		await runtime.http.respond(API, claudeSays("Pochette de l’album Decimate, fond rouge"));

		const item = await create(runtime, { title: "Decimate", cover: image("decimate.jpg") }, "fr");
		await waitForLog(runtime);

		const data = await publishedData(runtime, item.id);
		expect((data.cover as ImageValue).alt).toBe("Pochette de l’album Decimate, fond rouge");
		const [request, ...others] = sentBodies(runtime);
		expect(others).toEqual([]);
		expect(request!.apiKey).toBe(API_KEY);
		expect(request!.body.model).toBe("claude-haiku-4-5");
		expect(request!.body.messages[0]!.content[0]!.source!.url).toBe("https://example.com/_emdash/api/media/file/decimate.jpg");
		expect(request!.body.messages[0]!.content[1]!.text).toContain("French");
	});

	it("uses the language of English entries and the chosen model", async () => {
		const runtime = await setup({ apiKey: API_KEY, model: "claude-sonnet-5-5" });
		await runtime.http.respond(API, claudeSays("Red album cover"));

		await create(runtime, { title: "Decimate", cover: image("decimate.jpg") }, "en");
		await waitForLog(runtime);

		const [request] = sentBodies(runtime);
		expect(request!.body.model).toBe("claude-sonnet-5-5");
		expect(request!.body.messages[0]!.content[1]!.text).toContain("English");
	});

	it("keeps alt text written by people and only fills the missing one", async () => {
		const runtime = await setup();
		await runtime.http.respond(API, claudeSays("Verso de la pochette"));

		const item = await create(runtime, {
			title: "Decimate",
			cover: image("front.jpg", "Texte écrit à la main"),
			back: image("back.jpg"),
		});
		await waitForLog(runtime);

		const data = await publishedData(runtime, item.id);
		expect((data.cover as ImageValue).alt).toBe("Texte écrit à la main");
		expect((data.back as ImageValue).alt).toBe("Verso de la pochette");
		expect(runtime.http.requests()).toHaveLength(1);
	});

	it("leaves the entry untouched when Claude fails", async () => {
		const runtime = await setup();
		await runtime.http.respond(API, claudeSays("Overloaded", 529));

		const item = await create(runtime, { title: "Decimate", cover: image("decimate.jpg") });
		const [entry] = await waitForLog(runtime);
		expect(entry!.data).toMatchObject({ status: "error", field: "cover" });

		const data = await publishedData(runtime, item.id);
		expect(data.title).toBe("Decimate");
		expect((data.cover as ImageValue).alt).toBeUndefined();
	});

	it("respects the per-save limit", async () => {
		const runtime = await setup({ apiKey: API_KEY, maxPerSave: 1 });
		await runtime.http.respond(API, claudeSays("Recto"));

		const item = await create(runtime, { title: "Decimate", cover: image("front.jpg"), back: image("back.jpg") });
		await waitForLog(runtime);

		expect(runtime.http.requests()).toHaveLength(1);
		const data = await publishedData(runtime, item.id);
		expect([(data.cover as ImageValue).alt, (data.back as ImageValue).alt].filter(Boolean)).toEqual(["Recto"]);
	});

	it("does nothing without an API key", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		await create(runtime, { title: "Decimate", cover: image("decimate.jpg") });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(runtime.http.requests()).toEqual([]);
		await expect(runtime.inspect.storage.list("alt_log")).resolves.toEqual([]);
	});
});

describe("existing entries (content:beforeSave)", () => {
	it("fills missing alt text during the save, in the entry's language", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		const item = await create(runtime, { title: "Decimate", cover: image("decimate.jpg") }, "en");
		// Let the creation's afterSave hook finish (it ran without a key) before adding one.
		await new Promise((resolve) => setTimeout(resolve, 300));
		await configure(runtime, { apiKey: API_KEY });
		await runtime.http.respond(API, claudeSays("Red album cover"));

		const updated = await runtime.actions.content.update("albums", item.id, {
			data: { title: "Decimate (deluxe)", cover: image("decimate.jpg") },
		});
		if (!updated.success) throw new Error(updated.error.message);

		const data = await publishedData(runtime, item.id);
		expect(data.title).toBe("Decimate (deluxe)");
		expect((data.cover as ImageValue).alt).toBe("Red album cover");
		expect(runtime.http.requests()).toHaveLength(1);
		expect(sentBodies(runtime)[0]!.body.messages[0]!.content[1]!.text).toContain("English");
	});

	it("stores the API key encrypted", async () => {
		const runtime = await setup();
		const raw = await runtime.inspect.settings.raw<unknown>("apiKey");
		expect(JSON.stringify(raw)).not.toContain(API_KEY);
	});
});

describe("admin", () => {
	it("warns when the API key is missing and offers collections to scan", async () => {
		const runtime = await setup({ model: "claude-haiku-4-5" });
		const page = await runtime.admin.loadPage("/audit");
		expect(page.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "banner", title: "No Anthropic API key" }),
				expect.objectContaining({
					type: "actions",
					elements: [expect.objectContaining({ action_id: "scan", label: "Albums", value: "albums|" })],
				}),
			]),
		);
	});

	it("lists entries with missing alt text and writes it from the admin", async () => {
		const runtime = await setup({ apiKey: API_KEY, autoGenerate: false });
		const item = await create(runtime, { title: "Decimate", cover: image("decimate.jpg") });
		await create(runtime, { title: "Done", cover: image("done.jpg", "Déjà décrite") });

		const scan = await runtime.admin.act("/audit", "scan", { value: "albums|" });
		const table = scan.blocks.find((block) => block.type === "table") as unknown as {
			rows: Array<{ entry: string; fields: string; action: { value: string } }>;
		};
		expect(table.rows).toEqual([expect.objectContaining({ entry: "Decimate", fields: "cover" })]);

		await runtime.http.respond(API, claudeSays("Pochette rouge de Decimate"));
		const done = await runtime.admin.act("/audit", "generate", { value: table.rows[0]!.action.value });
		expect(done.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "fields", fields: [{ label: "cover", value: "Pochette rouge de Decimate" }] }),
				expect.objectContaining({ type: "banner", title: "Alt text saved" }),
			]),
		);
		const data = await publishedData(runtime, item.id);
		expect((data.cover as ImageValue).alt).toBe("Pochette rouge de Decimate");
	});

	it("shows recent activity in the dashboard widget", async () => {
		const runtime = await setup();
		const empty = await runtime.admin.loadWidget("activity");
		expect(empty.blocks).toEqual([expect.objectContaining({ type: "empty" })]);

		await runtime.http.respond(API, claudeSays("Pochette rouge"));
		await create(runtime, { title: "Decimate", cover: image("decimate.jpg") });
		await waitForLog(runtime);
		const widget = await runtime.admin.loadWidget("activity");
		expect(widget.blocks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "stats", items: expect.arrayContaining([expect.objectContaining({ value: 1 })]) }),
			]),
		);
	});
});
