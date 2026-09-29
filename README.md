# AI Alt Text

Alt text for the images on your [EmDash](https://emdashcms.com) site, written by Claude in the language of each entry, so that people using screen readers know what the images show (WCAG 1.1.1).

- **On save.** When an entry is saved, images without alt text get one. Alt text written by people is kept.
- **In the entry's language.** A French entry gets French alt text, an English entry English, and so on for any language EmDash supports.
- **Never in the way.** If Claude is slow, unavailable or declines an image, the entry is saved anyway, without alt text for that image.
- **Audit page.** *Alt text* in the admin lists, collection by collection, the entries whose images still lack alt text, with a button to write it.
- **Dashboard widget.** Recent activity: alt text written, failures, and the latest description.

## Requirements

- EmDash 1.0 or later with a sandbox runner (on Cloudflare: the `LOADER` Worker Loader binding, which needs a Workers paid plan).
- An [Anthropic API key](https://console.anthropic.com/).
- A **public** site: Claude downloads each image from its URL, so it cannot reach images on `localhost` or behind a login. Local development sites are skipped.
- Images in JPEG, PNG, GIF or WebP. Other formats (SVG, AVIF, HEIC) are skipped.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Anthropic API key | *(empty)* | Stored encrypted. Nothing is written without it. |
| Claude model | Claude Haiku 4.5 | Haiku is fast enough to run while content is saved. Claude Sonnet 5.5 and Claude Opus 5.5 write richer descriptions but take longer; with them, a declined image is retried on another model automatically. |
| Write alt text when content is saved | On | Turn off to write alt text only from the audit page. |
| Images per save | 3 | Up to 5. Images over the limit can be written from the audit page. |
| Rewrite existing alt text on save | Off | Off keeps alt text written by people. |
| Collections | *(all with an image field)* | Comma-separated slugs to limit the plugin to. |
| Public site URL | EmDash site URL | Where Claude downloads images from. |

## How it works

- **Existing entries**: the alt text is written during the save, so it is saved with the rest of the entry.
- **New entries**: EmDash does not tell plugins the language of an entry before it exists, so the alt text is written right after the first save. Like any plugin edit, it follows the collection's workflow: if the collection keeps drafts, the alt text is in the entry's draft and goes online when the entry is published.
- Alt text is one sentence of at most 125 characters. Claude does not name real people.
- Top-level image fields and images inside top-level lists (galleries) are covered. Images embedded in rich text are not, yet.

## Permissions

| Capability | Why |
|---|---|
| `content:write` | Required by EmDash for the save hook; saves alt text written from the audit page. |
| `content:read` | Reads entries for the audit page and the language of the entry being saved. |
| `schema:read` | Finds the collections that have image fields. |
| `network:request` | Calls the Claude API. Only `api.anthropic.com` is allowed. |

## Privacy and cost

Images are sent to Anthropic's API by URL, with the entry title as context. Anthropic does not use API data to train models. Each image costs a fraction of a cent with Claude Haiku 4.5 (about $1.30 per thousand 1-megapixel images at the time of writing).

## Development

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm run test    # builds the plugin and runs it through EmDash's Worker Loader sandbox, with Claude mocked
pnpm run build
```

## License

MIT © [La Symphonie](https://lasymphonieagency.com)
