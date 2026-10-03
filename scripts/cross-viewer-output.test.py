import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "cross-viewer-output.py"
FIXTURE = ROOT / "src-tauri" / "tests" / "fixtures" / "reportlab-mixed-fields.pdf"
PROFILES = ["comments", "forms", "raster-copy", "image-pdf", "page-operations"]


def minimal_pdf(width, height):
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents 4 0 R >>".encode(),
        b"<< /Length 0 >>\nstream\n\nendstream",
    ]
    body = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(body))
        body.extend(f"{number} 0 obj\n".encode() + value + b"\nendobj\n")
    xref = len(body)
    body.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        body.extend(f"{offset:010d} 00000 n \n".encode())
    body.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(body)


class CrossViewerOutputTests(unittest.TestCase):
    def test_five_profile_fixture_matrix_and_no_clobber(self):
        poppler = shutil.which("pdftoppm")
        if not poppler:
            self.skipTest("pdftoppm is unavailable")
        with tempfile.TemporaryDirectory(prefix="smacrobat-cross-viewer-test-") as folder:
            root = pathlib.Path(folder)
            fixture = root / "controlled.pdf"
            shutil.copyfile(FIXTURE, fixture)
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            manifest = {
                "schema": 1,
                "cases": [
                    {
                        "id": f"controlled-{profile}",
                        "profile": profile,
                        "source": fixture.name,
                        "sourceSha256": digest,
                        "output": fixture.name,
                        "outputSha256": digest,
                        "page": 1,
                        "dpi": 72,
                        "pixelSize": [612, 792],
                        "samples": [{"name": "white corner", "region": [0, 0, 8, 8], "minimum": [250, 250, 250], "maximum": [255, 255, 255]}],
                    }
                    for profile in PROFILES
                ],
            }
            manifest_path = root / "manifest.json"
            receipt_path = root / "receipt.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--manifest", str(manifest_path), "--receipt", str(receipt_path), "--poppler-bin", str(pathlib.Path(poppler).parent)]
            subprocess.run(command, check=True, timeout=90)
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(PROFILES, [case["profile"] for case in receipt["cases"]])
            self.assertEqual(5, len({case["id"] for case in receipt["cases"]}))
            self.assertTrue(all(case["pagePoints"] == [612.0, 792.0] for case in receipt["cases"]))
            self.assertTrue(all(case["pixelSize"] == [612, 792] for case in receipt["cases"]))
            self.assertEqual(1, len({case["renderSha256"] for case in receipt["cases"]}))
            self.assertTrue(all(case["samples"][0]["meanRgb"] == [255, 255, 255] for case in receipt["cases"]))
            rerun = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertNotEqual(0, rerun.returncode)
            self.assertIn("receipt already exists", rerun.stderr)

    def test_empty_matrix_is_rejected(self):
        poppler = shutil.which("pdftoppm")
        if not poppler:
            self.skipTest("pdftoppm is unavailable")
        with tempfile.TemporaryDirectory(prefix="smacrobat-cross-viewer-test-") as folder:
            root = pathlib.Path(folder)
            manifest = root / "manifest.json"
            manifest.write_text('{"schema":1,"cases":[]}', encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", str(manifest), "--receipt", str(root / "receipt.json"), "--poppler-bin", str(pathlib.Path(poppler).parent)],
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("1 through 32 cases", result.stderr)

    def test_oversized_page_is_rejected_before_render(self):
        poppler = shutil.which("pdftoppm")
        if not poppler:
            self.skipTest("pdftoppm is unavailable")
        with tempfile.TemporaryDirectory(prefix="smacrobat-cross-viewer-test-") as folder:
            root = pathlib.Path(folder)
            fixture = root / "oversized.pdf"
            fixture.write_bytes(minimal_pdf(100000, 100000))
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"schema": 1, "cases": [{"id": "oversized", "profile": "comments", "source": fixture.name, "sourceSha256": digest, "output": fixture.name, "outputSha256": digest, "page": 1, "dpi": 72, "pixelSize": [1, 1], "samples": []}]}), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--manifest", str(manifest), "--receipt", str(root / "receipt.json"), "--poppler-bin", str(pathlib.Path(poppler).parent)],
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("projected render exceeds the pixel limit", result.stderr)
            self.assertFalse((root / "receipt.json").exists())

    def test_path_escape_and_hash_mismatch_are_rejected(self):
        poppler = shutil.which("pdftoppm")
        if not poppler:
            self.skipTest("pdftoppm is unavailable")
        with tempfile.TemporaryDirectory(prefix="smacrobat-cross-viewer-test-") as folder:
            root = pathlib.Path(folder)
            fixture = root / "controlled.pdf"
            shutil.copyfile(FIXTURE, fixture)
            digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
            base = {"id": "controlled", "profile": "forms", "source": fixture.name, "sourceSha256": digest, "output": fixture.name, "outputSha256": digest, "page": 1, "dpi": 72, "pixelSize": [612, 792], "samples": []}
            for name, change, message in (
                ("escape", {"source": "../outside.pdf"}, "escapes the manifest directory"),
                ("hash", {"outputSha256": "0" * 64}, "outputSha256 mismatch"),
            ):
                case = dict(base)
                case.update(change)
                manifest = root / f"{name}.json"
                receipt = root / f"{name}-receipt.json"
                manifest.write_text(json.dumps({"schema": 1, "cases": [case]}), encoding="utf-8")
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "--manifest", str(manifest), "--receipt", str(receipt), "--poppler-bin", str(pathlib.Path(poppler).parent)],
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                self.assertNotEqual(0, result.returncode)
                self.assertIn(message, result.stderr)
                self.assertFalse(receipt.exists())


if __name__ == "__main__":
    unittest.main()
