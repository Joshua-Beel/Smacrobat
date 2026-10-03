#!/usr/bin/env python3
"""Render controlled saved-PDF outputs with Poppler and verify bounded pixel oracles."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import pathlib
import re
import shutil
import subprocess
import tempfile


SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_MANIFEST_BYTES = 256 * 1024
MAX_CASES = 32
MAX_PDF_BYTES = 256 * 1024 * 1024
MAX_RENDER_PIXELS = 40_000_000
MAX_RENDER_BYTES = MAX_RENDER_PIXELS * 3 + 1024
MAX_SAMPLES = 64
MAX_SAMPLE_PIXELS = 1_000_000
MAX_TOOL_OUTPUT_BYTES = 64 * 1024


def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def ppm(path: pathlib.Path) -> tuple[int, int, bytes]:
    if path.stat().st_size > MAX_RENDER_BYTES:
        raise ValueError(f"{path}: rendered output exceeds the byte limit")
    data = path.read_bytes()
    match = re.match(rb"P6\s+(?:#[^\r\n]*[\r\n]+\s*)*(\d+)\s+(\d+)\s+255\s", data)
    if not match:
        raise ValueError(f"{path}: expected an 8-bit binary PPM")
    width, height = (int(match.group(1)), int(match.group(2)))
    if width * height > MAX_RENDER_PIXELS:
        raise ValueError(f"{path}: rendered output exceeds the pixel limit")
    pixels = data[match.end() :]
    if len(pixels) != width * height * 3:
        raise ValueError(f"{path}: truncated or trailing PPM pixels")
    return width, height, pixels


def mean_rgb(pixels: bytes, width: int, region: list[int]) -> list[int]:
    if len(region) != 4 or any(type(value) is not int for value in region):
        raise ValueError("region must contain four integer pixel coordinates")
    left, top, right, bottom = region
    height = len(pixels) // 3 // width
    if left < 0 or top < 0 or right <= left or bottom <= top:
        raise ValueError("region is empty or negative")
    if right > width or bottom > height:
        raise ValueError("region exceeds rendered bounds")
    if (right - left) * (bottom - top) > MAX_SAMPLE_PIXELS:
        raise ValueError("region exceeds the sample pixel limit")
    total = [0, 0, 0]
    count = (right - left) * (bottom - top)
    for y in range(top, bottom):
        for x in range(left, right):
            offset = (y * width + x) * 3
            for channel in range(3):
                total[channel] += pixels[offset + channel]
    return [round(value / count) for value in total]


def exact_path(root: pathlib.Path, value: object, label: str) -> pathlib.Path:
    if not isinstance(value, str) or not value or pathlib.PurePath(value).is_absolute():
        raise ValueError(f"{label} must be a nonempty relative path")
    path = (root / value).resolve()
    if root != path and root not in path.parents:
        raise ValueError(f"{label} escapes the manifest directory")
    if not path.is_file():
        raise ValueError(f"{label} is missing")
    if path.stat().st_size > MAX_PDF_BYTES:
        raise ValueError(f"{label} exceeds the PDF byte limit")
    return path


def run_tool(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def read_bounded(stream: object) -> bytes:
        data = stream.read(MAX_TOOL_OUTPUT_BYTES // 2 + 1)
        if len(data) > MAX_TOOL_OUTPUT_BYTES // 2:
            process.kill()
            raise ValueError("tool diagnostic output exceeds the byte limit")
        return data

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        stdout_future = pool.submit(read_bounded, process.stdout)
        stderr_future = pool.submit(read_bounded, process.stderr)
        try:
            returncode = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise
        stdout = stdout_future.result().decode("utf-8", errors="replace")
        stderr = stderr_future.result().decode("utf-8", errors="replace")
    if returncode:
        raise subprocess.CalledProcessError(returncode, command, stdout, stderr)
    return subprocess.CompletedProcess(command, returncode, stdout, stderr)


def pdfinfo(executable: str, output: pathlib.Path, page: int) -> tuple[str, list[float]]:
    result = run_tool([executable, "-f", str(page), "-l", str(page), "-box", str(output)], 10)
    text = result.stdout
    pages = re.search(r"(?m)^Pages:\s+(\d+)\s*$", text)
    size = re.search(rf"(?m)^Page\s+{page}\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts", text)
    if not pages or page > int(pages.group(1)) or not size:
        raise ValueError("pdfinfo did not report the requested page")
    points = [float(size.group(1)), float(size.group(2))]
    if any(not math.isfinite(value) or value <= 0 for value in points):
        raise ValueError("pdfinfo reported invalid page dimensions")
    return digest(output), points


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--poppler-bin", type=pathlib.Path)
    arguments = parser.parse_args()
    manifest_path = arguments.manifest.resolve()
    receipt_path = arguments.receipt.resolve()
    if not manifest_path.is_file() or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("manifest is missing or exceeds the byte limit")
    if receipt_path.exists():
        raise ValueError("receipt already exists")
    if not receipt_path.parent.is_dir():
        raise ValueError("receipt parent directory is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or not isinstance(manifest.get("cases"), list):
        raise ValueError("manifest must use schema 1 and contain a cases array")
    if not manifest["cases"] or len(manifest["cases"]) > MAX_CASES:
        raise ValueError(f"manifest must contain 1 through {MAX_CASES} cases")
    executable = str(arguments.poppler_bin / "pdftoppm.exe") if arguments.poppler_bin else shutil.which("pdftoppm")
    if not executable or not pathlib.Path(executable).is_file():
        raise ValueError("pdftoppm is unavailable; supply --poppler-bin")
    executable = str(pathlib.Path(executable).resolve())
    info_name = "pdfinfo.exe" if pathlib.Path(executable).suffix.lower() == ".exe" else "pdfinfo"
    info_executable = str(pathlib.Path(executable).with_name(info_name))
    if not pathlib.Path(info_executable).is_file():
        raise ValueError("pdfinfo is unavailable beside pdftoppm")
    version = run_tool([executable, "-v"], 10)
    version_text = (version.stderr or version.stdout).splitlines()[0]
    results: list[dict[str, object]] = []
    seen: set[str] = set()
    with tempfile.TemporaryDirectory(prefix="smacrobat-cross-viewer-", dir=receipt_path.parent) as temporary:
        temporary_root = pathlib.Path(temporary)
        for index, case in enumerate(manifest["cases"]):
            identity = case.get("id")
            profile = case.get("profile")
            if not isinstance(identity, str) or not identity or identity in seen:
                raise ValueError(f"case {index}: id is empty or duplicated")
            if profile not in {"comments", "forms", "raster-copy", "image-pdf", "page-operations"}:
                raise ValueError(f"{identity}: unsupported profile")
            seen.add(identity)
            source = exact_path(manifest_path.parent, case.get("source"), f"{identity}.source")
            output = exact_path(manifest_path.parent, case.get("output"), f"{identity}.output")
            source_hash, output_hash = digest(source), digest(output)
            for label, actual in (("sourceSha256", source_hash), ("outputSha256", output_hash)):
                expected = case.get(label)
                if not isinstance(expected, str) or not SHA256.fullmatch(expected) or expected != actual:
                    raise ValueError(f"{identity}: {label} mismatch")
            page = case.get("page")
            dpi = case.get("dpi", 144)
            if type(page) is not int or page < 1 or type(dpi) is not int or dpi < 36 or dpi > 300:
                raise ValueError(f"{identity}: invalid page or DPI")
            output_hash_after_info, page_points = pdfinfo(info_executable, output, page)
            if output_hash_after_info != output_hash:
                raise ValueError(f"{identity}: output changed during pdfinfo inspection")
            projected_size = [math.ceil(value * dpi / 72) for value in page_points]
            if projected_size[0] * projected_size[1] > MAX_RENDER_PIXELS:
                raise ValueError(f"{identity}: projected render exceeds the pixel limit")
            expected_size = case.get("pixelSize")
            if (
                not isinstance(expected_size, list)
                or len(expected_size) != 2
                or any(type(value) is not int or value < 1 for value in expected_size)
                or expected_size[0] * expected_size[1] > MAX_RENDER_PIXELS
            ):
                raise ValueError(f"{identity}: invalid or oversized pixelSize")
            case_root = temporary_root / f"case-{index}"
            case_root.mkdir()
            prefix = case_root / "page"
            run_tool(
                [executable, "-f", str(page), "-l", str(page), "-r", str(dpi), "-singlefile", str(output), str(prefix)],
                30,
            )
            rendered = prefix.with_suffix(".ppm")
            if set(case_root.iterdir()) != {rendered}:
                raise ValueError(f"{identity}: renderer produced unexpected files")
            width, height, pixels = ppm(rendered)
            if expected_size != [width, height]:
                raise ValueError(f"{identity}: pixelSize mismatch; got {[width, height]}")
            samples = []
            declared_samples = case.get("samples", [])
            if not isinstance(declared_samples, list) or len(declared_samples) > MAX_SAMPLES:
                raise ValueError(f"{identity}: samples must be an array of at most {MAX_SAMPLES} entries")
            for sample in declared_samples:
                if not isinstance(sample, dict) or not isinstance(sample.get("name"), str) or not sample["name"]:
                    raise ValueError(f"{identity}: every sample requires a nonempty name")
                actual = mean_rgb(pixels, width, sample.get("region"))
                minimum, maximum = sample.get("minimum"), sample.get("maximum")
                if (
                    not isinstance(minimum, list)
                    or not isinstance(maximum, list)
                    or len(minimum) != 3
                    or len(maximum) != 3
                    or any(type(value) is not int or value < 0 or value > 255 for value in minimum + maximum)
                    or any(minimum[channel] > maximum[channel] for channel in range(3))
                ):
                    raise ValueError(f"{identity}: sample bounds must be RGB triples")
                if any(actual[channel] < minimum[channel] or actual[channel] > maximum[channel] for channel in range(3)):
                    raise ValueError(f"{identity}: sample {sample.get('name')} was {actual}")
                samples.append({"name": sample.get("name"), "region": sample.get("region"), "meanRgb": actual})
            output_hash_after_render = digest(output)
            if output_hash_after_render != output_hash:
                raise ValueError(f"{identity}: output changed during rendering")
            if digest(source) != source_hash:
                raise ValueError(f"{identity}: source changed during verification")
            results.append({"id": identity, "profile": profile, "sourceSha256": source_hash, "outputSha256": output_hash, "page": page, "dpi": dpi, "pagePoints": page_points, "pixelSize": [width, height], "renderSha256": hashlib.sha256(pixels).hexdigest(), "samples": samples})
    receipt = {"schema": 1, "scope": "Controlled repository fixtures and saved outputs rendered by Poppler; not arbitrary-PDF or Adobe evidence.", "renderer": version_text, "cases": results}
    with receipt_path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
