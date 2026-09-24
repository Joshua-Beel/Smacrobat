from pathlib import Path
from io import BytesIO

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "reportlab-page-labels.pdf"


def label(style=None, prefix=None, start=None):
    value = DictionaryObject()
    if style is not None:
        value[NameObject("/S")] = NameObject(f"/{style}")
    if prefix is not None:
        value[NameObject("/P")] = TextStringObject(prefix)
    if start is not None:
        value[NameObject("/St")] = NumberObject(start)
    return value


base = BytesIO()
drawing = canvas.Canvas(base, pagesize=letter)
for page in range(14):
    drawing.setFont("Helvetica", 18)
    drawing.drawString(72, 720, f"Page-label fixture physical page {page}")
    drawing.showPage()
drawing.save()

reader = PdfReader(BytesIO(base.getvalue()))
writer = PdfWriter()
writer.append_pages_from_reader(reader)
ranges = [
    (0, label("D", start=1)),
    (2, label("r", start=4)),
    (4, label("R", start=1)),
    (6, label("A", start=27)),
    (8, label("a", start=28)),
    (10, label(prefix="Appendix")),
    (12, label("D", prefix="N-", start=5)),
]
nums = ArrayObject()
for index, value in ranges:
    nums.extend([NumberObject(index), value])
writer._root_object[NameObject("/PageLabels")] = DictionaryObject({NameObject("/Nums"): nums})

with OUTPUT.open("wb") as stream:
    writer.write(stream)
raw = PdfReader(str(OUTPUT)).trailer["/Root"]["/PageLabels"].get_object()["/Nums"]
assert len(raw) == 14
assert [int(raw[index]) for index in range(0, len(raw), 2)] == [0, 2, 4, 6, 8, 10, 12]
assert raw[9].get_object()["/St"] == 28
assert raw[11].get_object()["/P"] == "Appendix" and "/S" not in raw[11].get_object()
