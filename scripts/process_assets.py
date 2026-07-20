#!/usr/bin/env python3
"""Build the web-ready pixel-art assets used by Links Downloader.

The GIF pipeline is intentionally lossless with respect to geometry: frames are
never scaled. Solid backgrounds are removed with a four-connected flood fill
seeded from every border pixel, so enclosed highlights and shadows survive.

Run from any directory with::

    python scripts/process_assets.py
"""

from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "pixelart"
OUTPUT_DIR = ROOT / "public" / "assets"

TRANSPARENT_INDEX = 0
# Keep entries 0 and 255 reserved. Index 0 is transparent; index 255 is a
# visually identical marker that prevents GIF encoders from folding intentional
# duplicate timing frames together.
GIF_COLORS = 254
TIMING_MARKER_INDEX = 255
PADDING = 8
CANVAS_STEP = 8
BACKGROUND_TOLERANCE = 24


@dataclass(frozen=True)
class AnimationSpec:
    output_name: str
    source_name: str
    remove_solid_background: bool


ANIMATIONS = (
    AnimationSpec("idle.gif", "descarga (2).gif", False),
    AnimationSpec("ready.gif", "descarga (3).gif", True),
    AnimationSpec("loading.gif", "descarga.gif", True),
    AnimationSpec("success.gif", "descarga (1).gif", True),
)


def _round_up(value: int, step: int) -> int:
    return ((value + step - 1) // step) * step


def _border_pixels(image: Image.Image) -> list[tuple[int, int, int]]:
    pixels = image.load()
    width, height = image.size
    border: list[tuple[int, int, int]] = []
    for x in range(width):
        border.append(pixels[x, 0][:3])
        if height > 1:
            border.append(pixels[x, height - 1][:3])
    for y in range(1, height - 1):
        border.append(pixels[0, y][:3])
        if width > 1:
            border.append(pixels[width - 1, y][:3])
    return border


def _is_close(
    color: tuple[int, int, int], target: tuple[int, int, int], tolerance: int
) -> bool:
    return max(abs(color[channel] - target[channel]) for channel in range(3)) <= tolerance


def remove_border_connected_background(
    frame: Image.Image, tolerance: int = 0
) -> tuple[Image.Image, tuple[int, int, int], int]:
    """Make only border-connected pixels matching the flat background transparent.

    Four-connectivity is deliberate for pixel art: a one-pixel diagonal sparkle
    is not accidentally joined to the surrounding background. The sources use
    exact flat fills, so a zero tolerance also retains pale glow pixels and soft
    shadow colors instead of treating them as background.
    """

    rgba = frame.convert("RGBA")
    width, height = rgba.size
    border = _border_pixels(rgba)
    background, occurrences = Counter(border).most_common(1)[0]
    dominance = occurrences / len(border)
    if dominance < 0.90:
        raise ValueError(
            f"Expected a solid border background, but {background} covers only "
            f"{dominance:.1%} of border pixels"
        )

    source = rgba.load()
    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        index = y * width + x
        if visited[index]:
            return
        red, green, blue, alpha = source[x, y]
        if alpha and _is_close((red, green, blue), background, tolerance):
            visited[index] = 1
            queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        if height > 1:
            enqueue(x, height - 1)
    for y in range(1, height - 1):
        enqueue(0, y)
        if width > 1:
            enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        if x:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)

    removed = 0
    for index, is_background in enumerate(visited):
        if is_background:
            source[index % width, index // width] = (0, 0, 0, 0)
            removed += 1

    return rgba, background, removed


def _load_frames(source: Path) -> tuple[list[Image.Image], list[int], int]:
    frames: list[Image.Image] = []
    durations: list[int] = []
    with Image.open(source) as animation:
        loop = int(animation.info.get("loop", 0))
        default_duration = int(animation.info.get("duration", 100))
        for index in range(animation.n_frames):
            animation.seek(index)
            frames.append(animation.convert("RGBA"))
            durations.append(int(animation.info.get("duration", default_duration)))
    return frames, durations, loop


def _union_bbox(frames: Iterable[Image.Image]) -> tuple[int, int, int, int]:
    boxes = [frame.getchannel("A").getbbox() for frame in frames]
    content_boxes = [box for box in boxes if box is not None]
    if not content_boxes:
        raise ValueError("Animation contains no visible pixels")
    return (
        min(box[0] for box in content_boxes),
        min(box[1] for box in content_boxes),
        max(box[2] for box in content_boxes),
        max(box[3] for box in content_boxes),
    )


def _square_normalize(frames: list[Image.Image]) -> list[Image.Image]:
    left, top, right, bottom = _union_bbox(frames)
    content_width = right - left
    content_height = bottom - top
    side = _round_up(max(content_width, content_height) + PADDING * 2, CANVAS_STEP)
    offset_x = (side - content_width) // 2 - left
    offset_y = (side - content_height) // 2 - top

    normalized: list[Image.Image] = []
    for frame in frames:
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.alpha_composite(frame, (offset_x, offset_y))
        normalized.append(canvas)
    return normalized


def _palette_frame(frame: Image.Image, timing_marker: bool) -> Image.Image:
    """Quantize RGB and retain intentional, visually identical timing frames.

    GIF encoders commonly merge consecutive duplicate images. Some source
    animations intentionally repeat a pose with separate durations, so odd
    frames mark one opaque pixel with a duplicate palette entry. The rendered
    color does not change, but the encoded frame remains independently timed.
    """

    alpha = frame.getchannel("A")
    clean = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    clean.paste(frame, (0, 0), alpha)
    quantized = clean.convert("RGB").quantize(
        colors=GIF_COLORS,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    )

    source_indices = quantized.tobytes()
    alpha_bytes = alpha.tobytes()
    shifted_indices = bytearray(len(source_indices))
    for index, (palette_index, opacity) in enumerate(zip(source_indices, alpha_bytes)):
        shifted_indices[index] = palette_index + 1 if opacity >= 128 else TRANSPARENT_INDEX

    source_palette = (quantized.getpalette() or [])[: GIF_COLORS * 3]
    source_palette += [0] * (GIF_COLORS * 3 - len(source_palette))
    palette = [0, 0, 0, *source_palette]

    marker_offset = next(
        (index for index, opacity in enumerate(alpha_bytes) if opacity >= 128), None
    )
    if marker_offset is None:
        raise ValueError("Cannot palette-encode an entirely transparent frame")
    original_index = shifted_indices[marker_offset]
    duplicate_color = palette[original_index * 3 : original_index * 3 + 3]
    palette.extend(duplicate_color)
    if timing_marker:
        shifted_indices[marker_offset] = TIMING_MARKER_INDEX

    output = Image.new("P", frame.size, TRANSPARENT_INDEX)
    output.frombytes(bytes(shifted_indices))
    output.putpalette(palette)
    output.info["transparency"] = TRANSPARENT_INDEX
    output.info["disposal"] = 2
    return output


def build_animation(spec: AnimationSpec) -> dict[str, object]:
    source = SOURCE_DIR / spec.source_name
    destination = OUTPUT_DIR / spec.output_name
    poster = OUTPUT_DIR / f"{Path(spec.output_name).stem}.png"
    if not source.is_file():
        raise FileNotFoundError(f"Missing source animation: {source}")

    frames, durations, loop = _load_frames(source)
    backgrounds: set[tuple[int, int, int]] = set()
    removed_pixels = 0
    processed: list[Image.Image] = []
    for frame in frames:
        if spec.remove_solid_background:
            frame, background, removed = remove_border_connected_background(
                frame, tolerance=BACKGROUND_TOLERANCE
            )
            backgrounds.add(background)
            removed_pixels += removed
        processed.append(frame)

    normalized = _square_normalize(processed)
    normalized[0].save(poster, format="PNG", optimize=True)
    paletted = [
        _palette_frame(frame, timing_marker=bool(index % 2))
        for index, frame in enumerate(normalized)
    ]
    paletted[0].save(
        destination,
        format="GIF",
        save_all=True,
        append_images=paletted[1:],
        duration=durations,
        loop=loop,
        disposal=[2] * len(paletted),
        transparency=TRANSPARENT_INDEX,
        # Palette optimization already happened above. Keeping the exact table
        # also preserves the duplicate timing marker used for repeated poses.
        optimize=False,
    )

    return {
        "name": destination.name,
        "poster_name": poster.name,
        "source": source.name,
        "expected_frames": len(frames),
        "expected_durations": durations,
        "expected_size": normalized[0].size,
        "source_bytes": source.stat().st_size,
        "backgrounds": sorted(backgrounds),
        "removed_pixels": removed_pixels,
    }


def _base_mark() -> Image.Image:
    """Draw a tiny RPG shield carrying a luminous L rune on a 16 px grid."""

    image = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    outline = "#090611"
    deep_gold = "#76501d"
    gold = "#d7ad42"
    violet = "#261a42"
    violet_light = "#573b80"
    rune_shadow = "#76572a"
    rune = "#f1d477"
    rune_light = "#fff4c2"

    draw.polygon(
        [(2, 2), (5, 1), (8, 2), (11, 1), (14, 2), (14, 8), (12, 12), (8, 15), (4, 12), (2, 8)],
        fill=outline,
    )
    draw.polygon(
        [(3, 3), (5, 2), (8, 3), (11, 2), (13, 3), (13, 8), (11, 11), (8, 14), (5, 11), (3, 8)],
        fill=deep_gold,
    )
    draw.polygon(
        [(4, 4), (6, 3), (8, 4), (10, 3), (12, 4), (12, 8), (10, 10), (8, 13), (6, 10), (4, 8)],
        fill=violet,
    )
    draw.polygon([(4, 4), (6, 3), (6, 10), (8, 13), (6, 10), (4, 8)], fill=violet_light)
    draw.point([(5, 5), (5, 7), (10, 4), (11, 7)], fill="#8a69b4")

    # Two-tone block rune: a warm legendary-gold face and dark extrusion.
    draw.rectangle((7, 5, 9, 10), fill=rune_shadow)
    draw.rectangle((8, 9, 11, 11), fill=rune_shadow)
    draw.rectangle((6, 4, 8, 9), fill=rune)
    draw.rectangle((7, 8, 10, 10), fill=rune)
    draw.line([(6, 4), (7, 4), (7, 8), (10, 8)], fill=rune_light, width=1)

    # A restrained gold glint keeps the mark legible against near-black UI.
    draw.point((3, 3), fill="#ffe69a")
    draw.point((12, 3), fill=gold)
    return image


def _nearest_scale(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.NEAREST)


def build_icons() -> list[Path]:
    base = _base_mark()
    icon_16 = base
    icon_32 = _nearest_scale(base, 32)
    icon_48 = _nearest_scale(base, 48)

    favicon = OUTPUT_DIR / "favicon.ico"
    # The largest image must be the primary Pillow ICO frame; append exact-size
    # frames so Pillow does not apply a soft resampling filter.
    icon_48.save(
        favicon,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[icon_16, icon_32],
    )

    icon_192 = OUTPUT_DIR / "icon-192.png"
    icon_512 = OUTPUT_DIR / "icon-512.png"
    _nearest_scale(base, 192).save(icon_192, format="PNG", optimize=True)
    _nearest_scale(base, 512).save(icon_512, format="PNG", optimize=True)
    return [favicon, icon_192, icon_512]


CURSOR_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">
  <title>Pixel art sword cursor</title>
  <polygon fill="#080611" points="1,1 7,2 21,16 24,13 27,16 23,20 29,26 29,29 26,29 20,23 16,27 13,24 16,21 2,7"/>
  <polygon fill="#9b91a7" points="3,3 6,4 19,17 17,19 4,6"/>
  <polygon fill="#f2ebdd" points="3,3 6,4 18,16 17,17 5,5"/>
  <polygon fill="#d6aa4a" points="20,15 25,20 23,22 18,17"/>
  <polygon fill="#9277d7" points="21,21 23,19 28,25 26,27"/>
  <rect fill="#d6aa4a" x="26" y="26" width="3" height="3"/>
  <rect fill="#fff4c2" x="26" y="26" width="1" height="1"/>
</svg>
"""


def build_cursor() -> Path:
    destination = OUTPUT_DIR / "cursor.svg"
    destination.write_text(CURSOR_SVG, encoding="utf-8", newline="\n")
    return destination


def validate_animation(record: dict[str, object]) -> dict[str, object]:
    path = OUTPUT_DIR / str(record["name"])
    poster_path = OUTPUT_DIR / str(record["poster_name"])
    with Image.open(path) as animation:
        frame_count = animation.n_frames
        if frame_count != record["expected_frames"]:
            raise AssertionError(
                f"{path.name}: expected {record['expected_frames']} frames, got {frame_count}"
            )
        if animation.size != record["expected_size"]:
            raise AssertionError(
                f"{path.name}: expected {record['expected_size']}, got {animation.size}"
            )

        durations: list[int] = []
        transparent_counts: list[int] = []
        opaque_counts: list[int] = []
        for index in range(animation.n_frames):
            animation.seek(index)
            durations.append(int(animation.info.get("duration", 0)))
            alpha = animation.convert("RGBA").getchannel("A")
            alpha_values = set(alpha.tobytes())
            if not alpha_values.issubset({0, 255}):
                raise AssertionError(f"{path.name}: frame {index} has non-binary GIF alpha")
            transparent = alpha.tobytes().count(0)
            opaque = alpha.tobytes().count(255)
            if transparent == 0 or opaque == 0:
                raise AssertionError(f"{path.name}: frame {index} lacks mixed alpha coverage")
            corners = (alpha.getpixel((0, 0)), alpha.getpixel((alpha.width - 1, 0)), alpha.getpixel((0, alpha.height - 1)), alpha.getpixel((alpha.width - 1, alpha.height - 1)))
            if any(corners):
                raise AssertionError(f"{path.name}: frame {index} has an opaque canvas corner")
            transparent_counts.append(transparent)
            opaque_counts.append(opaque)

        if durations != record["expected_durations"]:
            raise AssertionError(
                f"{path.name}: duration sequence changed from "
                f"{record['expected_durations']} to {durations}"
            )

    output_bytes = path.stat().st_size
    if output_bytes <= 0 or output_bytes > 2_000_000:
        raise AssertionError(f"{path.name}: implausible output weight ({output_bytes} bytes)")

    with Image.open(poster_path) as poster:
        rgba = poster.convert("RGBA")
        if poster.size != record["expected_size"]:
            raise AssertionError(
                f"{poster_path.name}: expected {record['expected_size']}, got {poster.size}"
            )
        alpha = rgba.getchannel("A")
        if set(alpha.tobytes()) != {0, 255}:
            raise AssertionError(f"{poster_path.name}: expected mixed binary alpha")
        corners = (
            alpha.getpixel((0, 0)),
            alpha.getpixel((alpha.width - 1, 0)),
            alpha.getpixel((0, alpha.height - 1)),
            alpha.getpixel((alpha.width - 1, alpha.height - 1)),
        )
        if any(corners):
            raise AssertionError(f"{poster_path.name}: has an opaque canvas corner")
    poster_bytes = poster_path.stat().st_size
    if poster_bytes <= 0 or poster_bytes > 1_000_000:
        raise AssertionError(
            f"{poster_path.name}: implausible output weight ({poster_bytes} bytes)"
        )

    return {
        **record,
        "frames": frame_count,
        "duration_ms": sum(durations),
        "size": tuple(record["expected_size"]),
        "alpha": "binary + transparent corners",
        "transparent_range": (min(transparent_counts), max(transparent_counts)),
        "opaque_range": (min(opaque_counts), max(opaque_counts)),
        "bytes": output_bytes,
        "poster_bytes": poster_bytes,
    }


def validate_icons(paths: list[Path]) -> None:
    favicon, icon_192, icon_512 = paths
    with Image.open(favicon) as icon:
        sizes = set(icon.ico.sizes())
        if sizes != {(16, 16), (32, 32), (48, 48)}:
            raise AssertionError(f"favicon.ico has unexpected sizes: {sorted(sizes)}")
        for size in sizes:
            rgba = icon.ico.getimage(size).convert("RGBA")
            if rgba.getpixel((0, 0))[3] != 0 or rgba.getchannel("A").getextrema() != (0, 255):
                raise AssertionError(f"favicon.ico {size} lacks valid transparency")

    for path, expected_size in ((icon_192, (192, 192)), (icon_512, (512, 512))):
        with Image.open(path) as icon:
            rgba = icon.convert("RGBA")
            if icon.size != expected_size or rgba.getchannel("A").getextrema() != (0, 255):
                raise AssertionError(f"{path.name} failed size/alpha validation")


def validate_cursor(path: Path) -> None:
    root = ET.parse(path).getroot()
    if root.attrib.get("viewBox") != "0 0 32 32":
        raise AssertionError("cursor.svg must use a 32 x 32 cursor-safe viewBox")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    records = [build_animation(spec) for spec in ANIMATIONS]
    icons = build_icons()
    cursor = build_cursor()

    validated = [validate_animation(record) for record in records]
    validate_icons(icons)
    validate_cursor(cursor)

    print("Generated and validated assets:")
    for record in validated:
        ratio = record["bytes"] / record["source_bytes"]
        print(
            f"- {record['name']}: {record['frames']} frames, "
            f"{record['duration_ms']} ms, {record['size'][0]}x{record['size'][1]}, "
            f"{record['bytes']} bytes ({ratio:.2f}x source), alpha OK"
        )
        print(
            f"- {record['poster_name']}: first-frame poster, "
            f"{record['size'][0]}x{record['size'][1]}, "
            f"{record['poster_bytes']} bytes, alpha OK"
        )
    for path in [*icons, cursor]:
        print(f"- {path.name}: {path.stat().st_size} bytes, validation OK")


if __name__ == "__main__":
    main()
