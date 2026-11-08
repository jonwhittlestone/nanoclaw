---
name: whatsapp-media
description: Handle photos, voice notes and files Jon sends on WhatsApp, and send files or images back. Use whenever a message carries an attachment, especially one with no instruction, or when Jon asks to "send me", "show me" or "share" a file or photo from the vault.
---

# WhatsApp media: receive and send

## Receiving: where the file is

An attachment shows up in the message as, for example:

```
[image: IMG-2026.jpg — saved to /workspace/inbox/<message-id>/IMG-2026.jpg]
```

The file is already on disk at that path. Read or copy it directly; there's nothing to download.
Inbox files are pruned after about 2 days, so copy anything worth keeping into the vault.

## Receiving: bare media (no instruction)

When an attachment arrives with no caption or no clear instruction, **don't ignore it and don't
guess**. Ask what Jon wants, tailored to the type, then wait for his reply:

**Image**
> 📷 I received a photo. What would you like me to do with it?
> • Save it to today's daily note
> • Save it somewhere else in the vault
> • Describe what's in it
> • Something else?

**Voice note.** Usually already transcribed and shown as `[Voice] …`; act on the text. If
there's no transcript:
> 🎙️ I received a voice note. What would you like me to do with it?
> • Save the audio to the vault
> • Something else?

**Document**
> 📄 I received a file (`<name>`). What would you like me to do with it?
> • Save it to the vault
> • Extract and summarise the text
> • Something else?

## Saving to the vault

The vault is mounted read-write at `/workspace/extra/obsidian`. Put images in Obsidian's
attachment folder (`attachmentFolderPath` in `.obsidian/app.json`, else the vault root) and embed
them with a wiki link. Daily notes live in `periodic/daily/YYYY-MM-DD-[W]WW-ddd.md`.

```python
import json, shutil
from pathlib import Path

VAULT = Path('/workspace/extra/obsidian')

def attachment_folder(vault: Path) -> Path:
    cfg = vault / '.obsidian' / 'app.json'
    if cfg.exists():
        folder = json.loads(cfg.read_text()).get('attachmentFolderPath', '')
        if folder and not folder.startswith('/'):
            return vault / folder
    return vault

src = Path('/workspace/inbox/<message-id>/IMG-2026.jpg')
dest = attachment_folder(VAULT) / src.name
dest.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(src, dest)
# then append  ![[IMG-2026.jpg]]  under the right heading of the daily note
```

## Sending a file or image back

Use the `send_file` tool. Its `path` is absolute or relative to `/workspace/agent/`; vault files
can be sent straight from `/workspace/extra/obsidian/...`, with no staging copy needed.

```
send_file(to="<this chat's destination>", path="/workspace/extra/obsidian/assets/chart.png",
          text="Here's the chart from your France trip note")
```

Images arrive as photos, audio as voice/audio, and everything else as a document.
