---
name: remarkable
description: Convert an Obsidian vault note to a reMarkable-friendly PDF saved next to the note (Dropbox syncs it to the tablet). Use when Jon asks to send a note or clipping to the reMarkable, put it on his tablet, or read it offline as a PDF.
---

# Send to reMarkable

Convert an Obsidian vault note to PDF and save it in the same folder as the original.
Dropbox syncs the PDF automatically; Jon then opens it via the reMarkable Dropbox connector.
No upload step: writing the PDF into the vault is the whole delivery.

## When to use

- "send [note] to the reMarkable" / "put [note] on my tablet"
- "convert [note] to PDF for the reMarkable"
- "I want to read [note] offline on my reMarkable"
- "convert this article to PDF" (for saved web clippings)

## How to invoke

```bash
python3 /home/node/.claude/skills/remarkable/md_to_remarkable.py "<path-or-search-term>"
```

The vault is mounted at `/workspace/extra/obsidian`. `<path-or-search-term>` can be:

- an exact vault-relative path: `trips/25-france-summer.md`
- a filename stem: `25-france-summer`
- a partial name: `france` (finds a unique match; errors if ambiguous)

If unsure of the exact path, search the vault first with Glob, then pass the result.
Add `--dry-run` to check which note resolves without converting.

## Examples

Jon: "send my France trip notes to the reMarkable"

```bash
python3 /home/node/.claude/skills/remarkable/md_to_remarkable.py "trips/25-france-summer.md"
```

Jon: "convert the AI Loser article to PDF"

```bash
python3 /home/node/.claude/skills/remarkable/md_to_remarkable.py "Clippings/@adlrocha - How the _AI Loser_ may end up winning.md"
```

When it succeeds, tell Jon the PDF's vault-relative path so he can find it on the tablet.

## If the script exits with code 2 (ambiguous)

List the candidates and ask which one he means.

## Known limitations

- `[[wiki-links]]` become plain text; linked note content is not inlined
- Dataview blocks and other plugin-specific syntax appear as literal code blocks
- Mermaid diagrams need `mmdc` (installed in this agent's image); without it they stay code blocks
- Web images (`![](https://...)`) are downloaded at conversion time and skipped if unavailable
- Webp images are converted to PNG via ImageMagick before embedding
- The PDF is saved at the same path as the `.md`, with a `.pdf` extension
