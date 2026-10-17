# AI Alt Text

Alt text for the images on your [EmDash](https://emdashcms.com) site, written by Claude, so that people using screen readers know what the images show (WCAG 1.1.1), in the language of each page.

EmDash already copies the alt text of a media library image into every entry that uses it without its own. AI Alt Text builds on that:

- **New images are described as soon as they are uploaded**, in the media library language, so every entry that uses them inherits the alt text. Alt text given with the upload is kept.
- **Images with no alt text anywhere are described when an entry using them is saved.** The alt text goes to the media library item, so every entry inherits it, and to the entry.
- **Entries in other languages get alt text in their own language.** An English entry no longer inherits the French alt text of its image: Claude translates it into English, checking it against the image, so the context and the names a person wrote are kept. Alt text copied from the entry it translates is translated the same way. With no alt text to start from, Claude describes the image in the entry's language.
- **Alt text written by people is kept.**
- **Never in the way.** If Claude is slow, unavailable or declines an image, the upload or the save goes through without alt text for that image. Saving an entry in the media library language never waits for Claude unless one of its images has no alt text at all.
- **Admin page.** *Alt text* finds the media library images that still have no alt text and describes them, two per click. It also lists, collection by collection, the current alt text of each entry's images, with a button to complete an entry (useful for translations made before the plugin was installed).
- **Dashboard widget.** Recent activity: alt text written, failures, and the latest description.

## Requirements

- EmDash 1.0 or later with a sandbox runner (on Cloudflare: the `LOADER` Worker Loader binding, which needs a Workers paid plan).
- On Cloudflare, describing images on upload and from the media library needs `@emdash-cms/cloudflare` **1.3.0** or later: earlier versions do not let sandboxed plugins read image files ([emdash#3646](https://github.com/emdash-cms/emdash/issues/3646)). With them, those images are logged as errors and get their alt text when an entry using them is saved.
- An [Anthropic API key](https://console.anthropic.com/), scoped to a workspace. A workspace spend limit is a good idea.
- A **public** site for images used in entries: Claude downloads them from their public URL, so it cannot reach images on `localhost` or behind a login. Media library images are sent as files and work anywhere.
- Images in JPEG, PNG, GIF or WebP. Other formats (SVG, AVIF, HEIC) are skipped.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Anthropic API key | *(empty)* | Stored encrypted. Nothing is written without it. |
| Claude model | Claude Haiku 4.5 | Haiku is fast enough to run while images are uploaded and entries saved. Claude Sonnet 5.5 and Claude Opus 5.5 write richer descriptions but take longer; with them, a declined image is retried on another model automatically. |
| Media library language | Site language | The language of the alt text stored in the media library, which entries in that language inherit. **Set it** if your EmDash site language setting differs from your content's main language: the admin page shows which one is used. |
| Describe new images on upload | On | Writes alt text on the media library item right after the upload. Alt text given with the upload, or typed while Claude writes, is kept. |
| Complete alt text when entries are saved | On | Describes images with no alt text, and translates alt text into the entry's language for entries in other languages. |
| Collections | *(all with an image field)* | Comma-separated slugs to limit the plugin to. |
| Public site URL | EmDash site URL | Where Claude downloads images from. |

## Good to know

- **Uploads never wait.** EmDash runs the upload hook after answering the upload, so the alt text appears in the media library a few seconds later.
- **Saving an entry in another language with a new image** waits for Claude (a few seconds) so that the alt text is saved with the entry. Nothing else waits.
- **New entries.** EmDash does not tell plugins the language of an entry before it exists, so the alt text of a new entry is written right after its first save. Like any plugin edit, it follows the collection's workflow: if the collection keeps drafts, it lands in the entry's draft and goes online when the entry is published.
- **Media library images over 3 MB** are not read in the sandbox (50 ms of CPU per request on Cloudflare): they get their alt text the first time an entry using them is saved, from their public URL.
- Alt text is one sentence of at most 125 characters; a translation may be as long as the alt text it translates. Claude never identifies people from their appearance: a name appears only when the alt text it translates already gives it.
- Top-level image fields and images inside top-level lists (galleries) are covered. Images embedded in rich text are not, yet.
- Each request stays within the sandbox's limits (10 host calls, 30 seconds): that is why the admin page describes media library images two at a time.
- **If the site's `EMDASH_ENCRYPTION_KEY` changes**, the stored API key can no longer be read: the admin page says so, and nothing is written until you enter the key again. Saves are never blocked.

## Permissions

| Capability | Why |
|---|---|
| `content:write` | Required by EmDash for the save hook; saves alt text into entries. |
| `content:read` | Reads entries, their language, and the entry they translate. |
| `schema:read` | Finds the collections that have image fields. |
| `media:read` | Required by EmDash for the upload hook; reads the media library alt text an image field inherits. |
| `media:bytes:read` | Reads media library images (up to 3 MB) to describe them: plugins get no public URL for them. |
| `media:metadata:write` | Saves alt text on media library items. This permission can only change alt text, caption and focal point. |
| `network:request` | Calls the Claude API. Only `api.anthropic.com` is allowed. |

## Privacy and cost

Images used in entries are sent to Anthropic's API by URL, with the entry title and, for translations, the existing alt text as context. Media library images are sent as file contents, with their file name as context. Anthropic does not use API data to train models. Each image costs a fraction of a cent with Claude Haiku 4.5 (about $1.30 per thousand 1-megapixel images at the time of writing).

## Development

```sh
pnpm install
pnpm run validate
pnpm run typecheck
pnpm run test    # builds the plugin and runs it through EmDash's Worker Loader sandbox, with Claude mocked
pnpm run build
```

## Changes

- **0.3.0**: new images are described on upload, and the admin page catches up on media library images without alt text. Needs the `media:bytes:read` permission, and on Cloudflare `@emdash-cms/cloudflare` 1.3.0 or later.
- **0.2.0**: entries in other languages get the existing alt text translated, checked against the image, instead of a new description. Translations keep the release, the artist and other names a person wrote; the admin shows which alt text was translated. A stored API key that can no longer be decrypted no longer breaks the admin page.
- **0.1.0**: first release.

## License

MIT © [La Symphonie](https://lasymphonieagency.com)
