"""Prints the guides in this folder to ../*.pdf with an installed Chrome, then adds a page header and footer.

    python docs/design/build_guides.py

Needs pypdf and reportlab. Edit the .html file, then run this; the PDFs are not edited by hand.
The architecture document has its own script, build_pdf.py.
"""
import io
import shutil
import subprocess
import tempfile
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
GUIDES = [
    ("simple-guide.html", "ResolveAI-Simple-Guide.pdf", "ResolveAI - simple guide"),
    ("knowledge-transfer.html", "ResolveAI-Knowledge-Transfer.pdf", "ResolveAI: Knowledge Transfer for New Engineers"),
]
CHROME = next(
    p for p in [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
    ] if p and Path(p).exists()
)


def stamp(pdf: Path, label: str) -> int:
    """Adds the document's name and the page number to every page."""
    reader = PdfReader(str(pdf))
    writer = PdfWriter()
    total = len(reader.pages)
    for number, page in enumerate(reader.pages, 1):
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        overlay = io.BytesIO()
        c = canvas.Canvas(overlay, pagesize=(width, height))
        c.setFont("Helvetica", 7.5)
        c.setFillGray(0.45)
        c.drawString(40, 22, label)
        c.drawRightString(width - 40, 22, f"Page {number} of {total}")
        c.save()
        overlay.seek(0)
        page.merge_page(PdfReader(overlay).pages[0])
        writer.add_page(page)
    writer.add_metadata({"/Title": label})
    with pdf.open("wb") as out:
        writer.write(out)
    return total


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        for source, output, label in GUIDES:
            pdf = HERE.parent / output
            # A separate profile, so this never touches a Chrome the person has open.
            subprocess.run(
                [CHROME, "--headless=new", "--disable-gpu", f"--user-data-dir={Path(tmp) / 'profile'}", "--no-pdf-header-footer",
                 "--generate-pdf-document-outline", f"--print-to-pdf={pdf}", (HERE / source).as_uri()],
                check=True, capture_output=True, timeout=120,
            )
            print(f"{pdf}: {stamp(pdf, label)} pages")


if __name__ == "__main__":
    main()
