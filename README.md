# AI Alt Text

Alt text for the images on your [EmDash](https://emdashcms.com) site, written by Claude, so that people using screen readers know what the images show (WCAG 1.1.1), in the language of each page.

EmDash already copies the alt text of a media library image into every entry that uses it without its own. AI Alt Text builds on that:

- **New images are described on upload.** The alt text goes to the media library item, so every entry inherits it.
- **Images with no alt text anywhere are described when an entry is saved**, in the media library and in the entry.
- **Entries in other languages get alt text in their own language.** An English entry no longer inherits the French description of its image: Claude writes an English one for that entry. Alt text copied from the entry it translates is replaced the same way.
- **Alt text written by people is kept.**
- **Never in the way.** If Claude is slow, unavailable or declines an image, the upload or the save goes through without alt text for that image. Saving an entry in the media library language never waits for Claude unless one of its images has no alt text at all.
- **Admin page.** *Alt text* lists media library images without alt text (with a button to describe them) and, collection by collection, the current alt text of each entry's images, to complete translations.
- **Dashboard widget.** Recent activity: alt text written, failures, and the latest description.

## Requirements

- EmDash 1.0 or later with a sandbox runner (on Cloudflare: the `LOADER` Worker Loader binding, which needs a Workers paid plan).
- An [Anthropic API key](https://console.anthropic.com/), scoped to a workspace. A workspace spend limit is a good idea.
- A **public** site: for images used in entries, Claude downloads the file from its public URL, so it cannot reach images on `localhost` or behind a login.
- Images in JPEG, PNG, GIF or WebP. Other formats (SVG, AVIF, HEIC) are skipped.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Anthropic API key | *(empty)* | Stored encrypted. Nothing is written without it. |
| Claude model | Claude Haiku 4.5 | Haiku is fast enough for uploads and saves. Claude Sonnet 5.5 and Claude Opus 5.5 write richer descriptions but take longer; with them, a declined image is retried on another model automatically. |
| Media library language | Site language | The language of the alt text stored in the media library, which entries in that language inherit. |
| Describe new images on upload | On | |
| Complete alt text when entries are saved | On | Describes images with no alt text, and writes alt text in the entry's language for entries in other languages. |
| Collections | *(all with an image field)* | Comma-separated slugs to limit the plugin to. |
| Public site URL | EmDash site URL | Where Claude downloads images used in entries from. |

## Good to know

- **Uploads.** EmDash 1.0.1 runs the upload hook without keeping it alive on some upload paths, so a new image may not be described right away on Cloudflare. It is then described the first time an entry using it is saved, or from the admin page.
- **Media library images over 3 MB** are described when an entry uses them rather than from the media library page: plugins cannot fetch media library files by URL, and larger files take too long to read in the sandbox.
- **New entries.** EmDash does not tell plugins the language of an entry before it exists, so the alt text of a new entry is written right after its first save. Like any plugin edit, it follows the collection's workflow: if the collection keeps drafts, it lands in the entry's draft and goes online when the entry is published.
- Alt text is one sentence of at most 125 characters. Claude does not name real people.
- Top-level image fields and images inside top-level lists (galleries) are covered. Images embedded in rich text are not, yet.
- Each request stays within the sandbox's limits (10 host calls, 30 seconds), so bulk actions handle two images at a time.

## Permissions

| Capability | Why |
|---|---|
| `content:write` | Required by EmDash for the save hook; saves alt text into entries. |
| `content:read` | Reads entries, their language, and the entry they translate. |
| `schema:read` | Finds the collections that have image fields. |
| `media:read` | Required by EmDash for the upload hook; reads media library alt text. |
| `media:bytes:read` | Reads media library images, which have no public URL for plugins (up to 3 MB). |
| `media:metadata:write` | Saves alt text on media library items. This permission can only change alt text, caption and focal point. |
| `network:request` | Calls the Claude API. Only `api.anthropic.com` is allowed. |

## Privacy and cost

Images are sent to Anthropic's API, by URL or as file contents, with the entry title or file name as context. Anthropic does not use API data to train models. Each image costs a fraction of a cent with Claude Haiku 4.5 (about $1.30 per thousand 1-megapixel images at the time of writing).

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
