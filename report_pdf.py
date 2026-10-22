"""
report_pdf.py — build the weekly press-review PDF for Le Kiosque.

Layout, in the Hodologic print style (Playfair Display and Poppins, ink and
the Kiosque bordeaux, the contour-field cover) with the Kiosque mark:
cover page (title, period, key figures), the LLM summary,
then three lets-plot charts (BBC-cookbook style via lekiosque_theme), each
framed by a computed intro paragraph and a "Lecture :" caption, a Références
section linking to the week's notable articles, and a Méthodologie closing.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date as _date
from datetime import datetime
from io import BytesIO
from zoneinfo import ZoneInfo

import os

from lekiosque_theme import (ACCENT, ACCENT_SOFT, FONT, INK, MUTED,
                             SOURCE_LINE, lekiosque_theme, to_png)

# Fonts shared with the Hodologic papers, and the Kiosque mark
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "report")

# Same reasoning as api.py's gabon_now(): the server's system timezone can
# differ from Gabon's fixed WAT (UTC+1, no DST), which would silently
# misjudge "today" near midnight on a machine set east of Gabon.
_GABON_TZ = ZoneInfo("Africa/Libreville")


def _gabon_today() -> _date:
    return datetime.now(_GABON_TZ).date()

WEEKDAYS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
WEEKDAYS_FR_SHORT = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
             "août", "septembre", "octobre", "novembre", "décembre"]

# Mirrors the frontend per-entity palette (validated categorical hues)
SOURCE_COLORS = {
    "gabonmediatime":    "#2a78d6",
    "gabonreview":       "#008300",
    "lunion":            "#e87ba4",
    "focusgroupemedia":  "#eda100",
    "gabonactu":         "#1baf7a",
    "directinfosgabon":  "#eb6834",
    "7joursinfo":        "#4a3aa7",
    "insidenews241":     "#e34948",
    "depeches241":       "#0f7ea8",
    "gabonallsport":     "#9a6a1f",
    "kongossanews":      "#b04ad1",
    "gabonquotidien":    "#6b7f22",
    "ethiquemediagabon": "#c2185b",
}
OTHER_COLOR = "#64748b"


# ── Charts (each returns (png_buffer, intro, caption)) ────────────────────────

def _chart_daily(by_day: dict) -> tuple[BytesIO, str, str]:
    from lets_plot import (aes, geom_bar, geom_text, ggplot, labs,
                           scale_fill_identity, scale_x_discrete,
                           scale_y_continuous)

    # Last 7 complete days: today's partial bucket would end on a misleading dip
    today = _gabon_today().isoformat()
    days = [d for d in sorted(by_day) if d != today][-7:]
    counts = [by_day[d] for d in days]
    peak = max(counts) if counts else 0
    peak_idx = counts.index(peak)

    labels = []
    for d in days:
        dt = datetime.fromisoformat(d)
        labels.append(f"{WEEKDAYS_FR_SHORT[dt.weekday()]} {dt.strftime('%d/%m')}")

    d0, d1 = datetime.fromisoformat(days[0]), datetime.fromisoformat(days[-1])
    data = {
        "day": labels,
        "n": counts,
        "fill": [ACCENT if i == peak_idx else ACCENT_SOFT for i in range(len(counts))],
    }
    p = (
        ggplot(data)
        + geom_bar(aes("day", "n", fill="fill"), stat="identity",
                   width=0.55, tooltips="none")
        + geom_text(aes("day", "y", label="lab"),
                    data={"day": [labels[peak_idx]], "y": [peak * 1.03],
                          "lab": [str(peak)]},
                    vjust=0, color=INK, family=FONT, fontface="bold", size=8)
        + scale_fill_identity()
        + scale_x_discrete(limits=labels)
        + scale_y_continuous(limits=[0, peak * 1.18 if peak else 1],
                             expand=[0, 0])
        + labs(title="Le rythme de la semaine",
               subtitle=(f"Articles publiés par jour, du {d0.strftime('%d/%m')} "
                         f"au {d1.strftime('%d/%m')}"),
               caption=SOURCE_LINE)
        + lekiosque_theme(grid="y")
    )

    total = sum(counts)
    avg = total / len(counts) if counts else 0
    peak_dt = datetime.fromisoformat(days[peak_idx])
    intro = (
        "Le volume de publication donne le tempo de l'actualité : les rédactions "
        "accélèrent quand l'agenda politique, économique ou sportif se densifie. "
        f"Cette semaine, l'activité a culminé le {WEEKDAYS_FR[peak_dt.weekday()]} "
        f"{peak_dt.strftime('%d/%m')}."
    )
    caption = (
        f"Lecture : {total} articles publiés sur les 7 derniers jours complets, "
        f"soit {avg:.0f} par jour en moyenne. Le pic du {WEEKDAYS_FR[peak_dt.weekday()]} "
        f"{peak_dt.strftime('%d/%m')} ({peak} articles) dépasse cette moyenne de "
        f"{(peak - avg) / avg * 100:.0f} %. Le creux du week-end est structurel "
        f"dans la presse en ligne."
    )
    return to_png(p, 900, 380), intro, caption


def _hbar(names: list[str], counts: list[int], fills: list[str],
          bar_labels: list[str], title: str, subtitle: str) -> "object":
    """Ranked horizontal bars, direct-labeled at the bar end (no value axis)."""
    from lets_plot import (aes, element_blank, geom_bar, geom_text, ggplot,
                           labs, scale_fill_identity, scale_x_continuous,
                           scale_y_discrete, theme)

    xmax = max(counts)
    data = {"name": names, "n": counts, "fill": fills,
            "lx": [c + xmax * 0.02 for c in counts], "lab": bar_labels}
    return (
        ggplot(data)
        + geom_bar(aes(x="n", y="name", fill="fill"), stat="identity",
                   orientation="y", width=0.62, tooltips="none")
        + geom_text(aes(x="lx", y="name", label="lab"), hjust=0,
                    color=INK, family=FONT, size=6.5)
        + scale_fill_identity()
        + scale_y_discrete(limits=names)
        + scale_x_continuous(limits=[0, xmax * 1.28], expand=[0, 0])
        + labs(title=title, subtitle=subtitle, caption=SOURCE_LINE)
        + lekiosque_theme(grid="none")
        + theme(axis_text_x=element_blank())
    )


def _chart_sources(by_source: dict, daily: bool = False) -> tuple[BytesIO, str, str]:
    entries = sorted(by_source.items(), key=lambda e: e[1])
    names = [e[0] for e in entries]
    counts = [e[1] for e in entries]
    total = sum(counts) or 1
    period = "aujourd'hui" if daily else "cette semaine"
    period_of = "du jour" if daily else "de la semaine"

    p = _hbar(
        names, counts,
        fills=[SOURCE_COLORS.get(n, OTHER_COLOR) for n in names],
        bar_labels=[f"{c} · {c / total * 100:.0f} %" for c in counts],
        title=f"Qui a publié {period}",
        subtitle="Nombre d'articles par média et part du volume total",
    )

    top = entries[-1]
    top3 = sum(c for _, c in entries[-3:])
    intro = (
        f"Le paysage médiatique suivi compte {len(names)} sources actives "
        f"{period}. La hiérarchie des volumes montre où se fabrique l'essentiel du "
        "flux d'information en ligne."
    )
    caption = (
        f"Lecture : {top[0]} est la source la plus prolifique {period_of} avec "
        f"{top[1]} articles ({top[1] / total * 100:.0f} % du volume). Les trois premières "
        f"sources concentrent {top3 / total * 100:.0f} % des {total} publications, "
        f"réparties sur {len(names)} médias suivis."
    )
    return to_png(p, 900, 34 * len(names) + 130), intro, caption


def _norm_cat(s: str) -> str:
    # Accent-, case- and plural-insensitive key ("Actualités" == "actualite")
    return unicodedata.normalize("NFD", s.lower().strip()) \
        .encode("ascii", "ignore").decode().rstrip("s")


def _chart_categories(by_category: dict, top: int = 8, daily: bool = False) -> tuple[BytesIO, str, str]:
    # Merge accent/case/plural variants coming from different sources
    merged: dict[str, list] = {}
    for name, count in by_category.items():
        key = _norm_cat(name)
        if key in merged:
            merged[key][1] += count
        else:
            merged[key] = [name, count]
    ranked = sorted(merged.values(), key=lambda e: e[1], reverse=True)
    entries = ranked[:top][::-1]
    names = [e[0][:28].capitalize() for e in entries]
    counts = [e[1] for e in entries]

    p = _hbar(
        names, counts,
        fills=[ACCENT] * len(names),
        bar_labels=[str(c) for c in counts],
        title="Les rubriques dominantes",
        subtitle=f"Articles par rubrique déclarée ({len(names)} premières)",
    )

    period_of = "du jour" if daily else "de la semaine"
    period_dom = "la journée" if daily else "la semaine"
    c1 = ranked[0]
    runners = ", devant " + " et ".join(
        f"{c[0].capitalize()} ({c[1]})" for c in ranked[1:3]
    ) if len(ranked) > 1 else ""
    intro = (
        "Au-delà du volume, la répartition par rubrique dessine les priorités "
        f"éditoriales {period_of} : ce que les rédactions ont choisi de couvrir, "
        "et dans quelles proportions."
    )
    caption = (
        f"Lecture : la rubrique {c1[0].capitalize()} domine {period_dom} avec {c1[1]} articles"
        f"{runners}. "
        f"Le classement reflète les rubriques déclarées par les rédactions elles-mêmes."
    )
    return to_png(p, 900, 34 * len(names) + 130), intro, caption


# ── Word cloud of the period's headlines ─────────────────────────────────────

# French function words of 4+ letters that survive the length filter, plus
# corpus-generic vocabulary; keys are accent-stripped like _tokens output
_CLOUD_STOP = {
    "cest", "nest", "dune", "chaque", "plusieurs", "notamment", "toujours",
    "quand", "quel", "quelle", "quels", "quelles", "dont", "afin", "lors",
    "face", "contre", "depuis", "pendant", "avoir", "etait", "sera", "seront",
    "veut", "peut", "peuvent", "doit", "doivent", "font", "fera", "voici",
    "voila", "bientot", "enfin", "autour", "aupres", "notre", "votre", "quoi",
    "actualite", "actualites", "info", "infos", "journal", "medias", "media",
    # Calendar words: every period would be dominated by its own month
    "janvier", "fevrier", "mars", "avril", "juin", "juillet", "aout",
    "septembre", "octobre", "novembre", "decembre",
    "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
}

# macOS first, then the Linux equivalents shipped in the container image
# (fonts-liberation, fonts-dejavu-core). Without a match WordCloud falls back
# to its bundled DroidSansMono, which has no French accents.
_CLOUD_FONTS = (
    os.path.join(ASSETS, "Poppins-SemiBold.ttf"),
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

# Bordeaux and ink dominate, warm and slate tones for the rest
_CLOUD_PALETTE = [ACCENT, ACCENT, ACCENT, INK, INK, "#34495A", "#A8433A",
                  "#8A6A43", MUTED, "#6B8F7A"]


def _chart_wordcloud(articles: list, daily: bool = False):
    """Word-frequency cloud of the period's titles, or None if too few words."""
    import random

    from wordcloud import WordCloud

    # Count accent-insensitively but display the most common surface form
    # ("économie", not "economie")
    forms: dict[str, dict[str, int]] = {}
    for _day, _source, _cat, title, _url in articles:
        # Hyphenated names stay whole ("Port-Gentil", "Franceville-Mvengué")
        for w in re.findall(r"[a-zA-ZÀ-ſ]+(?:-[a-zA-ZÀ-ſ]+)*", title or ""):
            wl = w.lower()
            key = unicodedata.normalize("NFD", wl).encode("ascii", "ignore").decode()
            if len(key) < 4 or key in _STOP or key in _CLOUD_STOP:
                continue
            forms.setdefault(key, {})
            forms[key][wl] = forms[key].get(wl, 0) + 1
    freqs = {max(f, key=f.get): sum(f.values()) for f in forms.values()}
    if len(freqs) < 12:
        return None

    rng = random.Random(7)
    font = next((f for f in _CLOUD_FONTS if os.path.exists(f)), None)
    wc = WordCloud(
        width=1800, height=740, background_color="white", max_words=100,
        prefer_horizontal=0.95, font_path=font, margin=6, random_state=7,
        color_func=lambda *a, **k: rng.choice(_CLOUD_PALETTE),
    )
    buf = BytesIO()
    wc.generate_from_frequencies(freqs).to_image().save(buf, "PNG")
    buf.seek(0)

    period = "du jour" if daily else "de la semaine"
    top = sorted(freqs.items(), key=lambda e: -e[1])[:3]
    intro = (
        f"Avant toute synthèse, les mots qui reviennent le plus dans les titres "
        f"{period} donnent une photographie brute des sujets qui ont occupé "
        "les rédactions."
    )
    caption = (
        f"Lecture : les {min(len(freqs), 100)} mots les plus fréquents des titres "
        f"{period}, la taille étant proportionnelle au nombre d'occurrences. "
        "En tête : " + ", ".join(f"« {w} » ({n})" for w, n in top) + ". "
        "Mots outils et mentions génériques (Gabon, Libreville) exclus."
    )
    return buf, intro, caption


# ── Summary text → flowables ─────────────────────────────────────────────────

def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _md_to_flowables(text: str, styles) -> list:
    from reportlab.platypus import Paragraph
    flows = []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line in ("---", "***"):
            continue
        is_bullet = line.startswith(("- ", "* ", "• "))
        if is_bullet:
            line = line[2:].strip()
        html = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", _escape(line))
        html = html.replace("&lt;b&gt;", "<b>").replace("&lt;/b&gt;", "</b>")
        if is_bullet:
            flows.append(Paragraph(html, styles["kbullet"], bulletText="•"))
        elif re.fullmatch(r"\*\*.+\*\*", line):
            flows.append(Paragraph(html, styles["ktheme"]))
        else:
            flows.append(Paragraph(html, styles["kbody"]))
    return flows


# ── Références (articles of the week, linked to the originals) ───────────────

# Ubiquitous corpus words: useless for matching a title against the summary
_STOP = {
    "dans", "pour", "avec", "cette", "plus", "sans", "sous", "chez", "vers",
    "sont", "fait", "faire", "leur", "leurs", "tout", "tous", "toute", "toutes",
    "apres", "avant", "entre", "encore", "deux", "trois", "elle", "elles",
    "mais", "donc", "ainsi", "alors", "comme", "être", "etre", "aussi",
    "gabon", "gabonais", "gabonaise", "gabonaises", "libreville",
    "semaine", "article", "articles", "presse",
}


def _tokens(s: str) -> set[str]:
    s = unicodedata.normalize("NFD", s.lower()).encode("ascii", "ignore").decode()
    return {w for w in re.findall(r"[a-z0-9]{4,}", s)} - _STOP


def _select_references(text: str, articles: list, limit: int = 12) -> list:
    """Articles whose titles overlap the summary most (i.e. the ones the LLM
    talked about), newest first among equals; topped up with the latest
    articles when few titles match."""
    summary = _tokens(text)
    scored = []
    for row in articles:
        t = _tokens(row[3])
        if not t:
            continue
        scored.append((len(t & summary) / len(t), row))
    scored.sort(key=lambda e: (-e[0], e[1][0]))

    picked: list = []
    picked_toks: list[set] = []

    def add(row) -> None:
        # Skip near-duplicate titles (same story scraped by several sources)
        t = _tokens(row[3])
        for p in picked_toks:
            if t and len(t & p) / min(len(t), len(p)) >= 0.7:
                return
        picked.append(row)
        picked_toks.append(t)

    for score, row in scored:
        if score < 0.55 or len(picked) >= limit:
            break
        add(row)
    if len(picked) < 6:
        for row in sorted(articles, key=lambda r: r[0], reverse=True):
            if len(picked) >= min(limit, 10):
                break
            if row[3] and row[4]:
                add(row)
    return picked


def _references_flowables(text: str, articles: list, styles, daily: bool = False) -> list:
    from reportlab.platypus import Paragraph
    refs = _select_references(text, articles)
    if not refs:
        return []
    flows = [
        *_h2("Références", styles),
        Paragraph(
            f"Sélection d'articles marquants {'du jour' if daily else 'de la semaine'}, "
            "cités ou proches des thèmes de la synthèse. "
            "Chaque titre renvoie à l'article original.",
            styles["kbody"],
        ),
    ]
    for i, (day, source, _cat, title, url) in enumerate(refs, 1):
        try:
            date_fr = datetime.fromisoformat(day).strftime("%d/%m")
        except ValueError:
            date_fr = day
        t = _escape(title)
        head = (f'<link href="{url}"><font color="{ACCENT}"><u>{t}</u></font></link>'
                if url else t)
        flows.append(Paragraph(
            f'{head} &nbsp;<font color="{MUTED}" size="8.5">{_escape(source)} · {date_fr}</font>',
            styles["kref"], bulletText=f"{i}.",
        ))
    return flows


# ── PDF assembly ──────────────────────────────────────────────────────────────

_fonts_done = False


def _register_fonts() -> None:
    """Playfair Display (headings) and Poppins (text), as in the Hodologic papers."""
    global _fonts_done
    if _fonts_done:
        return
    from reportlab.lib.fonts import addMapping
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for name in ("Poppins-Regular", "Poppins-Medium", "Poppins-SemiBold",
                 "PlayfairDisplay-Regular"):
        pdfmetrics.registerFont(TTFont(name, os.path.join(ASSETS, f"{name}.ttf")))
    # <b> inside body paragraphs; no italics anywhere, so <i> stays upright
    for italic in (0, 1):
        addMapping("Poppins-Regular", 0, italic, "Poppins-Regular")
        addMapping("Poppins-Regular", 1, italic, "Poppins-SemiBold")
        # Playfair is shipped in regular only: bold falls back to regular
        for bold in (0, 1):
            addMapping("PlayfairDisplay-Regular", bold, italic, "PlayfairDisplay-Regular")
    _fonts_done = True


def _h2(text: str, styles) -> list:
    """Section heading: a rule in ink above a Playfair title."""
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import CondPageBreak, Paragraph
    from reportlab.platypus.flowables import HRFlowable
    return [CondPageBreak(40 * mm),
            HRFlowable(width="100%", thickness=0.3 * mm, color=colors.HexColor(INK),
                       spaceBefore=7 * mm, spaceAfter=3 * mm),
            Paragraph(_escape(text), styles["kh2"])]


def _tracked(c, x: float, y: float, text: str, font: str, size: float,
             tracking: float, color: str, align: str = "left") -> None:
    """Letter-spaced capitals (tracking in em), the Hodologic label style."""
    from reportlab.lib import colors
    from reportlab.pdfbase.pdfmetrics import stringWidth
    text = text.upper()
    space = tracking * size
    width = stringWidth(text, font, size) + space * (len(text) - 1)
    if align == "right":
        x -= width
    t = c.beginText(x, y)
    t.setFont(font, size)
    t.setCharSpace(space)
    t.setFillColor(colors.HexColor(color))
    t.textOut(text)
    # Tc is graphics state: reset it or it leaks into every later string
    t.setCharSpace(0)
    c.drawText(t)


def _date_fr(d: datetime) -> str:
    return f"{d.day} {MONTHS_FR[d.month - 1]} {d.year}"


def build_weekly_pdf(text: str, start: datetime, now: datetime, n_articles: int,
                     by_source: dict, by_category: dict, by_day: dict,
                     articles: list | None = None, daily: bool = False) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm, mm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (Image, KeepTogether, PageBreak, Paragraph,
                                    SimpleDocTemplate, Spacer)

    _register_fonts()
    W, H = A4
    kind = "Point d'actualité" if daily else "Revue de presse"
    title = "Le point d'actualité du jour" if daily else "Revue de presse de la semaine"
    if daily:
        period = f"Édition du {WEEKDAYS_FR[now.weekday()]} {_date_fr(now)}"
        dek = (f"{n_articles} articles de {len(by_source)} journaux en ligne, "
               "résumés et mis en graphiques. Chaque référence renvoie à l'article original.")
        meta2 = ("Édition", _date_fr(now))
    else:
        top_day = max(by_day, key=by_day.get) if by_day else None
        try:
            top_dt = datetime.fromisoformat(top_day)
            top_day_fr = f"le {WEEKDAYS_FR[top_dt.weekday()]} {top_dt.day} {MONTHS_FR[top_dt.month - 1]}"
        except (TypeError, ValueError):
            top_day_fr = None
        period = f"Semaine du {_date_fr(start)} au {_date_fr(now)}"
        dek = (f"{n_articles} articles de {len(by_source)} journaux en ligne, résumés et mis en graphiques"
               + (f" ; le jour le plus actif a été {top_day_fr} ({by_day.get(top_day, 0)} articles)."
                  if top_day_fr else "."))
        meta2 = ("Période", f"{start.strftime('%d/%m')} – {now.strftime('%d/%m/%Y')}")
    meta = [("Auteur", "Le Kiosque · Hodologic"), meta2,
            ("Généré le", now.strftime("%d/%m/%Y à %H:%M"))]
    running = f"Le Kiosque · {kind}"

    styles = getSampleStyleSheet()
    body_font = dict(fontName="Poppins-Regular", textColor=colors.HexColor(INK))
    styles.add(ParagraphStyle("kkind", fontName="Poppins-SemiBold", fontSize=7, leading=9,
                              textColor=colors.HexColor(ACCENT), spaceAfter=3 * mm))
    styles.add(ParagraphStyle("kh1", fontName="PlayfairDisplay-Regular", fontSize=22,
                              leading=25.5, textColor=colors.HexColor(INK)))
    styles.add(ParagraphStyle("kmeta", fontName="Poppins-Regular", fontSize=8.5, leading=11,
                              textColor=colors.HexColor(MUTED), spaceBefore=3 * mm,
                              spaceAfter=7 * mm))
    styles.add(ParagraphStyle("kh2", fontName="PlayfairDisplay-Regular", fontSize=17,
                              leading=20.5, textColor=colors.HexColor(INK), spaceAfter=3.5 * mm))
    styles.add(ParagraphStyle("ktheme", fontName="PlayfairDisplay-Regular", fontSize=12.5,
                              leading=16, textColor=colors.HexColor(INK),
                              spaceBefore=5 * mm, spaceAfter=2 * mm))
    styles.add(ParagraphStyle("kbody", **body_font, fontSize=9.6, leading=15.5,
                              alignment=TA_LEFT, spaceAfter=2.6 * mm))
    styles.add(ParagraphStyle("kbullet", parent=styles["kbody"], leftIndent=5.5 * mm,
                              bulletIndent=1 * mm, bulletColor=colors.HexColor(ACCENT),
                              spaceAfter=1.4 * mm))
    styles.add(ParagraphStyle("kintro", parent=styles["kbody"], spaceBefore=4 * mm,
                              spaceAfter=3 * mm))
    styles.add(ParagraphStyle("kcaption", fontName="Poppins-Regular", fontSize=8, leading=12,
                              textColor=colors.HexColor(MUTED), spaceBefore=2 * mm,
                              spaceAfter=3 * mm))
    styles.add(ParagraphStyle("kref", **body_font, fontSize=8.8, leading=13,
                              leftIndent=6 * mm, bulletIndent=0, bulletFontName="Poppins-SemiBold",
                              bulletColor=colors.HexColor(ACCENT), spaceAfter=2 * mm))
    styles.add(ParagraphStyle("kdek", fontName="PlayfairDisplay-Regular", fontSize=12,
                              leading=18, textColor=colors.HexColor("#34495A")))
    styles.add(ParagraphStyle("ktitle", fontName="PlayfairDisplay-Regular", fontSize=34,
                              leading=36, textColor=colors.HexColor(INK)))

    def draw_cover(c, doc):
        c.saveState()
        left, right, top = 18 * mm, W - 18 * mm, H - 16 * mm
        ink = colors.HexColor(INK)

        # The Kiosque mark, large, where the Hodologic papers put their field
        big = 92 * mm
        c.drawImage(os.path.join(ASSETS, "kiosque-mark-large.png"), left, H - 40 * mm - big,
                    width=big, height=big, mask="auto")

        # Top bar: Kiosque mark and wordmark, document kind on the right
        mark = 7.5 * mm
        c.drawImage(os.path.join(ASSETS, "kiosque-mark.png"), left, top - mark,
                    width=mark, height=mark, mask="auto")
        c.setFont("PlayfairDisplay-Regular", 13)
        c.setFillColor(ink)
        wx, wy = left + mark + 3.2 * mm, top - mark + 2.3 * mm
        c.drawString(wx, wy, "Le Kiosque")
        c.setStrokeColor(colors.HexColor(ACCENT))
        c.setLineWidth(0.5 * mm)
        ww = c.stringWidth("Le Kiosque", "PlayfairDisplay-Regular", 13)
        c.line(wx, wy - 1.6 * mm, wx + ww, wy - 1.6 * mm)
        _tracked(c, right, top - mark / 2 - 1 * mm, kind, "Poppins-SemiBold", 7, 0.2,
                 ACCENT, "right")
        c.setStrokeColor(ink)
        c.setLineWidth(0.3 * mm)
        c.line(left, top - mark - 5 * mm, right, top - mark - 5 * mm)

        # Footer
        foot_y = 14 * mm
        _tracked(c, left, foot_y, "Données · Modèles · Décisions", "Poppins-SemiBold", 6.5,
                 0.22, MUTED)
        _tracked(c, right, foot_y, "hodologic.fr", "Poppins-SemiBold", 6.5, 0.22, MUTED, "right")
        c.setStrokeColor(colors.Color(15 / 255, 42 / 255, 58 / 255, alpha=0.2))
        c.setLineWidth(0.2 * mm)
        c.line(left, foot_y + 3.5 * mm, right, foot_y + 3.5 * mm)

        # Meta: three labelled columns under an ink rule
        meta_y = foot_y + 3.5 * mm + 10 * mm
        col = (right - left + 8 * mm) / 3
        for i, (label, value) in enumerate(meta):
            x = left + i * col
            c.setFont("Poppins-Regular", 9.5)
            c.setFillColor(ink)
            c.drawString(x, meta_y, value)
            _tracked(c, x, meta_y + 4.6 * mm, label, "Poppins-SemiBold", 6.5, 0.18, MUTED)
        rule_y = meta_y + 9.5 * mm
        c.setStrokeColor(ink)
        c.setLineWidth(0.3 * mm)
        c.line(left, rule_y, right, rule_y)

        # Kicker, title and dek, stacked upward from the meta rule
        width = 150 * mm
        dek_p = Paragraph(_escape(f"{period}. {dek}"), styles["kdek"])
        _, dh = dek_p.wrap(140 * mm, H)
        y = rule_y + 12 * mm
        dek_p.drawOn(c, left, y)
        title_p = Paragraph(_escape(title), styles["ktitle"])
        _, th = title_p.wrap(width, H)
        y += dh + 7 * mm
        title_p.drawOn(c, left, y)
        y += th + 6 * mm
        c.setStrokeColor(colors.HexColor(MUTED))
        c.setLineWidth(0.25 * mm)
        c.line(left, y + 1 * mm, left + 8 * mm, y + 1 * mm)
        _tracked(c, left + 11 * mm, y, "Le Kiosque · presse gabonaise", "Poppins-SemiBold",
                 7.5, 0.2, MUTED)
        c.restoreState()

    def draw_page(c, doc):
        c.saveState()
        _tracked(c, 20 * mm, 11 * mm, running, "Poppins-SemiBold", 6.5, 0.18, MUTED)
        c.setFont("Poppins-Medium", 8)
        c.setFillColor(colors.HexColor(MUTED))
        c.drawRightString(W - 20 * mm, 11 * mm, str(doc.page))
        c.restoreState()

    def _img(buf: BytesIO, width):
        iw, ih = ImageReader(buf).getSize()
        buf.seek(0)
        return Image(buf, width=width, height=width * ih / iw)

    def chart_block(png, intro, caption):
        return [
            Paragraph(intro, styles["kintro"]),
            KeepTogether([_img(png, 17 * cm), Paragraph(caption, styles["kcaption"])]),
        ]

    sources = _chart_sources(by_source, daily=daily)
    cats = _chart_categories(by_category, daily=daily)
    # The 7-day rhythm chart is meaningless over a single day
    rhythm_blocks = [] if daily else [*chart_block(*_chart_daily(by_day)), PageBreak()]

    refs = _references_flowables(text, articles or [], styles, daily=daily)
    # References open a fresh page, unless there are none at all
    refs_blocks = [PageBreak(), *refs] if refs else []

    cloud = _chart_wordcloud(articles or [], daily=daily)
    cloud_blocks = [] if cloud is None else [
        Paragraph("Les mots " + ("du jour" if daily else "de la semaine"), styles["ktheme"]),
        *chart_block(*cloud),
        Spacer(1, 8),
    ]

    story = [
        PageBreak(),  # page 1 is the canvas-drawn cover
        Paragraph(_escape(kind.upper()), styles["kkind"]),
        Paragraph("Synthèse du jour" if daily else "Synthèse de la semaine", styles["kh1"]),
        Paragraph(_escape(f"{period} · {n_articles} articles · {len(by_source)} sources"),
                  styles["kmeta"]),
        *_md_to_flowables(text, styles),
        PageBreak(),  # charts section starts on a fresh page
        Paragraph(_escape(kind.upper()), styles["kkind"]),
        Paragraph("La journée en graphiques" if daily else "La semaine en graphiques",
                  styles["kh1"]),
        Spacer(1, 5 * mm),
        *cloud_blocks,
        *rhythm_blocks,
        *chart_block(*sources),
        *chart_block(*cats),
        *refs_blocks,
        *_h2("Méthodologie", styles),
        Paragraph(
            f"Le Kiosque collecte en continu les articles publiés en ligne par "
            f"{len(by_source)} médias gabonais. Chaque article est horodaté, rattaché "
            "à la rubrique déclarée par sa rédaction, puis indexé dans le corpus. "
            "Les chiffres et graphiques de ce rapport sont calculés automatiquement "
            "depuis ce corpus, sur "
            + ("la journée écoulée." if daily else "la fenêtre des sept derniers jours."),
            styles["kbody"],
        ),
        Paragraph(
            "La synthèse éditoriale est rédigée par un modèle de langage, à partir des "
            "seuls titres " + ("du jour. " if daily else "de la semaine. ")
            + "Elle peut comporter des imprécisions et ne remplace pas la lecture des "
            "articles originaux, accessibles depuis la section Références.",
            styles["kbody"],
        ),
    ]

    buf = BytesIO()
    SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=22 * mm, bottomMargin=20 * mm,
        title=f"Le Kiosque · {title}",
        author="Le Kiosque · Hodologic",
    ).build(story, onFirstPage=draw_cover, onLaterPages=draw_page)
    return buf.getvalue()
