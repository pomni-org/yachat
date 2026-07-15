from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "src" / "renderer"
ASSETS = RENDERER / "assets"
MASTER = ASSETS / "yachat-avatar.svg"
WORKFLOW = ROOT / ".github" / "workflows" / "apply-yachat-brand.yml"
TEXT_EXTENSIONS = {".css", ".js", ".cjs", ".mjs", ".html", ".json", ".webmanifest", ".py", ".md", ".txt", ".yml", ".yaml"}


def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def svg_document(path_data: str, *, background: str | None, logo: str, rounded: bool = False, gradients: str = "") -> str:
    rect = ""
    if background == "gradient":
        radius = ' rx="245"' if rounded else ""
        rect = (
            f'<rect width="1254" height="1254"{radius} fill="url(#bg)"/>'
            f'<rect width="1254" height="1254"{radius} fill="url(#blueGlow)"/>'
            f'<rect width="1254" height="1254"{radius} fill="url(#violetGlow)"/>'
        )
    elif background:
        radius = ' rx="245"' if rounded else ""
        rect = f'<rect width="1254" height="1254"{radius} fill="{background}"/>'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" role="img" aria-label="ЯЧат">'
        '<title>ЯЧат</title>' + gradients + rect
        + f'<path d="{path_data}" fill="{logo}" fill-rule="evenodd" clip-rule="evenodd"/>'
        + '</svg>\n'
    )


def create_svg_sources() -> None:
    source = MASTER.read_text(encoding="utf-8")
    path_match = re.search(r'<path d="(.*?)"\s+fill="#ffffff"', source, flags=re.DOTALL)
    defs_match = re.search(r'(<defs>.*?</defs>)', source, flags=re.DOTALL)
    if not path_match or not defs_match:
        raise SystemExit("Canonical YaChat SVG is malformed")
    path_data = path_match.group(1)
    gradients = defs_match.group(1)
    variants = {
        "yachat-avatar.svg": svg_document(path_data, background="gradient", logo="#ffffff", rounded=True, gradients=gradients),
        "yachat-color-square.svg": svg_document(path_data, background="gradient", logo="#ffffff", gradients=gradients),
        "yachat-logo-light.svg": svg_document(path_data, background=None, logo="#ffffff"),
        "yachat-logo-dark.svg": svg_document(path_data, background=None, logo="#000000"),
        "yachat-shortcut.svg": svg_document(path_data, background="#ffffff", logo="#000000"),
        "yachat-favicon.svg": svg_document(path_data, background="#ffffff", logo="#000000"),
        "yachat-notification-mark.svg": svg_document(path_data, background=None, logo="#ffffff"),
    }
    for name, content in variants.items():
        (ASSETS / name).write_text(content, encoding="utf-8")


def render(source: str, target: str, size: int) -> None:
    run("rsvg-convert", "-w", str(size), "-h", str(size), str(ASSETS / source), "-o", str(ASSETS / target))


def generate_rasters() -> None:
    render("yachat-color-square.svg", "yachat-color-square.png", 1254)
    render("yachat-avatar.svg", "yachat-color-rounded.png", 1254)
    render("yachat-logo-light.svg", "yachat-logo-light.png", 1254)
    render("yachat-logo-dark.svg", "yachat-logo-dark.png", 1254)
    render("yachat-notification-mark.svg", "yachat-notification-mark.png", 96)
    shortcut_sizes = (16, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024)
    favicon_sizes = (16, 32, 48, 64, 128, 256)
    for size in shortcut_sizes:
        render("yachat-shortcut.svg", f"yachat-shortcut-{size}.png", size)
    for size in favicon_sizes:
        render("yachat-favicon.svg", f"yachat-favicon-{size}.png", size)
    for size in (192, 512):
        shutil.copyfile(ASSETS / f"yachat-shortcut-{size}.png", ASSETS / f"yachat-shortcut-maskable-{size}.png")
    run("convert", str(ASSETS / "yachat-color-rounded.png"), "-quality", "96", str(ASSETS / "yachat-codes-avatar.jpeg"))
    run("convert", str(ASSETS / "yachat-color-rounded.png"), "-quality", "96", str(ASSETS / "yachat-codes-avatar.webp"))
    ico_inputs = [str(ASSETS / f"yachat-favicon-{size}.png") for size in favicon_sizes]
    for target in (ASSETS / "yachat.ico", RENDERER / "favicon.ico", RENDERER / "favicon-v2.ico", RENDERER / "favicon-v3.ico"):
        run("convert", *ico_inputs, str(target))


def copy(source: Path, target: Path) -> None:
    if source.resolve() == target.resolve():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def named_size(name: str, fallback: int) -> int:
    found = re.findall(r"(?<!\d)(16|32|48|64|96|128|180|192|256|512|1024|1254)(?!\d)", name)
    return int(found[-1]) if found else fallback


def nearest(value: int, values: tuple[int, ...]) -> int:
    return min(values, key=lambda candidate: abs(candidate - value))


def replace_legacy_files() -> None:
    shortcuts = (16, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024)
    favicons = (16, 32, 48, 64, 128, 256)
    for path in list(ASSETS.iterdir()):
        if not path.is_file():
            continue
        name = path.name.lower()
        ext = path.suffix.lower()
        if name == "maxsans-bold.ttf":
            path.unlink()
        elif name.startswith("apple-touch-icon") and ext == ".png":
            copy(ASSETS / "yachat-shortcut-180.png", path)
        elif name.startswith("yachat-app-icon") and ext == ".png":
            size = named_size(name, 512)
            if "maskable" in name:
                copy(ASSETS / f"yachat-shortcut-maskable-{nearest(size, (192, 512))}.png", path)
            else:
                copy(ASSETS / f"yachat-shortcut-{nearest(size, shortcuts)}.png", path)
        elif name.startswith("yachat-favicon") and ext == ".png" and not re.fullmatch(r"yachat-favicon-(16|32|48|64|128|256)\.png", name):
            copy(ASSETS / f"yachat-favicon-{nearest(named_size(name, 32), favicons)}.png", path)
        elif name.startswith("yachat-codes-avatar"):
            source = ASSETS / ("yachat-codes-avatar.webp" if ext == ".webp" else "yachat-codes-avatar.jpeg")
            if ext == ".svg":
                source = ASSETS / "yachat-avatar.svg"
            elif ext == ".png":
                source = ASSETS / "yachat-color-rounded.png"
            copy(source, path)
        elif name.startswith("yachat-logo") and name not in {"yachat-logo-light.svg", "yachat-logo-dark.svg", "yachat-logo-light.png", "yachat-logo-dark.png"}:
            light = "light" in name or "white" in name
            source = ASSETS / f"yachat-logo-{'light' if light else 'dark'}{ext if ext in {'.svg', '.png'} else '.svg'}"
            copy(source, path)
        elif name == "yachat-icon.svg":
            copy(ASSETS / "yachat-avatar.svg", path)
        elif name == "yachat-icon-square.png":
            copy(ASSETS / "yachat-color-square.png", path)
        elif name == "yachat-icon-mark.png":
            copy(ASSETS / "yachat-notification-mark.png", path)


def patch_text(text: str, path: Path) -> str:
    exact = {
        "yachat-logo-LIGHT.png": "yachat-logo-light.svg",
        "yachat-logo-DARK.png": "yachat-logo-dark.svg",
        "yachat-codes-avatar-v2.jpeg": "yachat-avatar.svg",
        "yachat-codes-avatar.webp": "yachat-avatar.svg",
        "yachat-icon-mark.png": "yachat-notification-mark.png",
        "yachat-icon.svg": "yachat-avatar.svg",
        "apple-touch-icon-v2.png": "yachat-shortcut-180.png",
        "apple-touch-icon.png": "yachat-shortcut-180.png",
    }
    for old, new in exact.items():
        text = text.replace(old, new)
    text = re.sub(r"yachat-app-icon(?:-v2)?-maskable-(192|512)\.png", r"yachat-shortcut-maskable-\1.png", text)
    text = re.sub(r"yachat-app-icon(?:-v2)?-(192|512|1024)\.png", r"yachat-shortcut-\1.png", text)
    text = re.sub(r"yachat-favicon(?:-v2)?-(16|32|48|256)\.png", r"yachat-favicon-\1.png", text)
    if path.name.endswith(".html"):
        text = text.replace('href="/manifest.webmanifest"', 'href="/manifest.webmanifest?v=4"')
        text = re.sub(r'href="/manifest\.webmanifest\?v=\d+"', 'href="/manifest.webmanifest?v=4"', text)
    if path.name == "styles.css":
        text = re.sub(r'@font-face\s*\{\s*font-family:\s*"Max Sans";.*?\}\s*', "", text, flags=re.DOTALL)
        text = re.sub(r'--font-logo:\s*"Max Sans"[^;]*;', '--font-logo: "Roboto", "Segoe UI", Arial, sans-serif;', text)
    return text


def patch_repository() -> None:
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts or path in {MASTER, Path(__file__), WORKFLOW}:
            continue
        if path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        try:
            old = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        new = patch_text(old, path)
        if new != old:
            path.write_text(new, encoding="utf-8")


def validate() -> None:
    required = [
        ASSETS / "yachat-avatar.svg", ASSETS / "yachat-color-square.svg",
        ASSETS / "yachat-logo-light.svg", ASSETS / "yachat-logo-dark.svg",
        ASSETS / "yachat-shortcut-180.png", ASSETS / "yachat-shortcut-512.png",
        ASSETS / "yachat-shortcut-maskable-512.png", ASSETS / "yachat-favicon-32.png",
        ASSETS / "yachat.ico", RENDERER / "favicon-v3.ico",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.exists() or path.stat().st_size == 0]
    if missing:
        raise SystemExit("Missing generated brand assets: " + ", ".join(missing))
    forbidden = ("MaxSans-Bold.ttf", "yachat-logo-LIGHT.png", "yachat-logo-DARK.png", "yachat-codes-avatar-v2.jpeg")
    offenders: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts or path in {Path(__file__), WORKFLOW} or path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if any(token in text for token in forbidden):
            offenders.append(str(path.relative_to(ROOT)))
    if offenders:
        raise SystemExit("Old branding references remain: " + ", ".join(offenders))


def cleanup() -> None:
    for path in (Path(__file__), WORKFLOW):
        if path.exists():
            path.unlink()


def main() -> None:
    for command in ("rsvg-convert", "convert"):
        if shutil.which(command) is None:
            raise SystemExit(f"Missing required command: {command}")
    create_svg_sources()
    generate_rasters()
    replace_legacy_files()
    patch_repository()
    validate()
    cleanup()


if __name__ == "__main__":
    main()
