# Send to reMarkable

Convert an Obsidian vault note to PDF and save it in the same folder as the original.
Dropbox syncs the PDF automatically — the user then opens it via the reMarkable
Dropbox connector.

## When to use

- "send [note] to the reMarkable" / "put [note] on my tablet"
- "convert [note] to PDF for the reMarkable"
- "I want to read [note] offline on my reMarkable"
- "convert this article to PDF" (for saved web clippings)

## How to invoke

```bash
python3 /workspace/project/scripts/md_to_remarkable.py "<path-or-search-term>"
```

The `<path-or-search-term>` can be:
- Exact vault-relative path: `trips/25-france-summer.md`
- Filename stem: `25-france-summer`
- Partial name: `france` (finds a unique match; errors if ambiguous)

If unsure of the exact path, search first with Glob, then pass the result to the script.

## Examples

User: "send my France trip notes to the reMarkable"
```bash
python3 /workspace/project/scripts/md_to_remarkable.py "trips/25-france-summer.md"
```

User: "convert the AI Loser article to PDF"
```bash
python3 /workspace/project/scripts/md_to_remarkable.py "Clippings/@adlrocha - How the _AI Loser_ may end up winning.md"
```

## If the script exits with code 2 (ambiguous)

List the candidates to the user and ask which one they mean.

## Known limitations

- `[[wiki-links]]` become plain text — linked note content is not inlined
- Dataview blocks and other plugin-specific syntax appear as literal code blocks
- Mermaid diagrams require `mmdc` to be installed (graceful degradation to code block if absent)
- Web images (`![](https://...)`) are downloaded at conversion time — skipped silently if the URL is unavailable
- Webp images from CDNs (e.g. substackcdn) are converted to PNG via ImageMagick before embedding
- The PDF is saved at the same path as the .md but with a `.pdf` extension
