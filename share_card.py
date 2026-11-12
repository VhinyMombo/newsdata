"""The picture WhatsApp shows above a shared answer's link (/r/<id>/image.jpg): the
answer's title, large, in the Kiosque's colours, with the newspapers it cites.

1200 x 630, the size WhatsApp and the other apps show in full; JPEG, so it stays
far under the weight WhatsApp accepts for a preview. The site's own type: Newsreader
for the title and the name, Hanken Grotesk for the rest (assets/share, OFL)."""
import io
import os
import re
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "share")
W, H = 1200, 630
PAPER = "#F7F4F3"
INK = "#0F2A3A"
CLARET = "#7A1F2B"
MUTED = "#4C6170"
ROSE = "#D9B8BC"
LEFT = 84
RIGHT = W - 84


@lru_cache(maxsize=32)
def _font(name: str, size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    """Variable fonts, set as the site sets them: Newsreader's optical size follows
    the type size (6 to 72), as browsers do on their own."""
    font = ImageFont.truetype(os.path.join(ASSETS, f"{name}.ttf"), size)
    axes = [weight] if name == "HankenGrotesk" else [weight, max(6, min(72, size))]
    font.set_variation_by_axes(axes)
    return font


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, width: int) -> list[str]:
    # French spacing before : ; ? ! » stays unbroken, never opening a line
    text = re.sub(r"\s+([:;?!»])", "\u00a0\\1", re.sub(r"(«)\s+", "\\1\u00a0", " ".join(text.split())))
    lines, line = [], ""
    for word in text.split(" "):
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def _fit_title(draw, title: str, width: int, max_height: int):
    """The largest size at which the title holds in the space, down to a floor where
    the end is cut with an ellipsis rather than shrunk out of reading."""
    for size in (92, 84, 76, 70, 64, 58, 52, 47, 43):
        font = _font("Newsreader", size)
        lines = _wrap(draw, title, font, width)
        step = int(size * 1.18)
        if len(lines) * step <= max_height:
            return font, lines, step
    font = _font("Newsreader", 43)
    step = int(43 * 1.18)
    keep = max(1, max_height // step)
    lines = _wrap(draw, title, font, width)
    if len(lines) > keep:
        lines = lines[:keep]
        while lines[-1] and draw.textlength(lines[-1] + " …", font=font) > width:
            lines[-1] = lines[-1].rsplit(" ", 1)[0] if " " in lines[-1] else lines[-1][:-1]
        lines[-1] += " …"
    return font, lines, step


def _spaced(draw, xy, text: str, font, fill, tracking: float):
    """Small capitals with air between the letters, as on the site's kickers."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x


def render(title: str, newspapers: list[str], kicker: str = "LA PRESSE EN PARLE") -> bytes:
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, 12), fill=CLARET)
    d.rectangle((0, H - 6, W, H), fill=ROSE)

    # The mark and the name, top left
    mark = Image.open(os.path.join(ASSETS, "kiosque-mark.png")).convert("RGBA")
    mark.thumbnail((64, 64))
    im.paste(mark, (LEFT, 52), mark)
    # The name as in the site's header: Newsreader semibold, a claret rule under it
    nfont = _font("Newsreader", 40, 600)
    d.text((LEFT + 82, 56), "Le Kiosque", font=nfont, fill=INK)
    d.rectangle((LEFT + 82, 104, LEFT + 82 + d.textlength("Le Kiosque", font=nfont), 106), fill=CLARET)
    _spaced(d, (LEFT, 150), kicker, _font("HankenGrotesk", 19, 600), CLARET, 3.0)

    # The title, as large as it holds
    title = " ".join(title.split())
    title = title[:1].upper() + title[1:]   # as typed, but never starting in lower case
    font, lines, step = _fit_title(d, title, RIGHT - LEFT, 290)
    y = 206
    for line in lines:
        d.text((LEFT, y), line, font=font, fill=INK)
        y += step

    # Rule, then where it comes from and where to read it
    d.rectangle((LEFT, 520, LEFT + 120, 523), fill=CLARET)
    names = [n for n in dict.fromkeys(newspapers) if n][:3]
    if names:
        cite = "D'après " + ", ".join(names)
        cfont = _font("HankenGrotesk", 24)
        while d.textlength(cite, font=cfont) > RIGHT - LEFT - 330 and len(names) > 1:
            names = names[:-1]
            cite = "D'après " + ", ".join(names) + "…"
        d.text((LEFT, 548), cite, font=cfont, fill=MUTED)
    site = "lekiosque.hodologic.fr"
    sfont = _font("HankenGrotesk", 24, 600)
    d.text((RIGHT - d.textlength(site, font=sfont), 548), site, font=sfont, fill=CLARET)

    out = io.BytesIO()
    im.save(out, "JPEG", quality=86, optimize=True, progressive=True)
    return out.getvalue()
