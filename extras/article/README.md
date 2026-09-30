# Architecture article

`dot-imessage-architecture.md` is the editable source. The `.txt`, `.docx`, and `.pdf` files are the final prepared exports from the September 30 implementation snapshot.

To regenerate the Word document, install Python 3 and `python-docx`, then run:

```sh
python build_docx.py dot-imessage-architecture.md revised.docx
```

Export the revised DOCX to PDF with a compatible word processor and inspect page breaks before sharing. The original final PDF is included so no external conversion service is needed to read it. This article is a historical architecture explanation, not a fresh device-test or uptime guarantee.
