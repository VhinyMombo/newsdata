"""
report_pdf.py — build the weekly press-review PDF for Le Kiosque.

Layout: cover page (title, period, key figures, author), the LLM summary,
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

from lekiosque_theme import (ACCENT, ACCENT_SOFT, FONT, INK, MUTED,
                             SOURCE_LINE, lekiosque_theme, to_png)

# Same reasoning as api.py's gabon_now(): the server's system timezone can
# differ from Gabon's fixed WAT (UTC+1, no DST), which would silently
# misjudge "today" near midnight on a machine set east of Gabon.
_GABON_TZ = ZoneInfo("Africa/Libreville")


def _gabon_today() -> _date:
    return datetime.now(_GABON_TZ).date()

BAND = "#0e5432"

WEEKDAYS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
WEEKDAYS_FR_SHORT = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]

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

_CLOUD_FONTS = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)

# BAND/ACCENT greens first (they dominate), then validated categorical hues
_CLOUD_PALETTE = [BAND, ACCENT, ACCENT, "#2a78d6", "#eda100", "#e34948",
                  "#4a3aa7", "#1baf7a", "#eb6834", INK]


def _chart_wordcloud(articles: list, daily: bool = False):
    """Word-frequency cloud of the period's titles, or None if too few words."""
    import os
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
        Paragraph("Références", styles["kh2"]),
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

def build_weekly_pdf(text: str, start: datetime, now: datetime, n_articles: int,
                     by_source: dict, by_category: dict, by_day: dict,
                     articles: list | None = None, daily: bool = False) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (Image, KeepTogether, PageBreak, Paragraph,
                                    SimpleDocTemplate, Spacer)

    W, H = A4
    if daily:
        period = f"Édition du {now.strftime('%d/%m/%Y')}"
        figures = f"{n_articles} articles  ·  {len(by_source)} sources"
    else:
        period = f"Semaine du {start.strftime('%d/%m/%Y')} au {now.strftime('%d/%m/%Y')}"
        top_day = max(by_day, key=by_day.get) if by_day else "?"
        try:
            top_dt = datetime.fromisoformat(top_day)
            top_day_fr = f"{WEEKDAYS_FR[top_dt.weekday()]} {top_dt.strftime('%d/%m')}"
        except ValueError:
            top_day_fr = top_day
        figures = (
            f"{n_articles} articles  ·  {len(by_source)} sources  ·  "
            f"jour le plus actif : {top_day_fr} ({by_day.get(top_day, 0)} articles)"
        )

    def draw_cover(canvas, doc):
        c = canvas
        c.saveState()
        c.setFillColor(colors.HexColor(BAND))
        c.rect(0, H - 5.2 * cm, W, 5.2 * cm, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 34)
        c.drawString(2 * cm, H - 2.6 * cm, "Le Kiosque")
        c.setFont("Helvetica", 13)
        c.drawString(2 * cm, H - 3.5 * cm, "Plateforme d'intelligence documentaire de la presse gabonaise")
        c.setFillColor(colors.HexColor(INK))
        c.setFont("Helvetica-Bold", 27)
        if daily:
            c.drawString(2 * cm, H / 2 + 2.2 * cm, "Le point d'actualité")
            c.drawString(2 * cm, H / 2 + 1.1 * cm, "du jour")
        else:
            c.drawString(2 * cm, H / 2 + 2.2 * cm, "Revue de presse")
            c.drawString(2 * cm, H / 2 + 1.1 * cm, "hebdomadaire")
        c.setStrokeColor(colors.HexColor(ACCENT))
        c.setLineWidth(3)
        c.line(2 * cm, H / 2 + 0.45 * cm, 6.5 * cm, H / 2 + 0.45 * cm)
        c.setFillColor(colors.HexColor(INK))
        c.setFont("Helvetica", 15)
        c.drawString(2 * cm, H / 2 - 0.7 * cm, period)
        c.setFillColor(colors.HexColor(MUTED))
        c.setFont("Helvetica", 11.5)
        c.drawString(2 * cm, H / 2 - 1.5 * cm, figures)
        c.setFillColor(colors.HexColor(INK))
        c.setFont("Helvetica-Bold", 12)
        c.drawString(2 * cm, 3.4 * cm, "Auteur : Le Kiosque")
        c.setFillColor(colors.HexColor(MUTED))
        c.setFont("Helvetica", 10)
        c.drawString(2 * cm, 2.75 * cm,
                     f"Rapport généré automatiquement le {now.strftime('%d/%m/%Y à %H:%M')}")
        c.drawString(2 * cm, 2.25 * cm,
                     "Synthèse rédigée par IA locale · chiffres calculés depuis le corpus")
        c.setFillColor(colors.HexColor(BAND))
        c.rect(0, 0, W, 0.5 * cm, fill=1, stroke=0)
        c.restoreState()

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle("kh2", fontName="Helvetica-Bold", fontSize=16,
                              leading=20, textColor=colors.HexColor(ACCENT),
                              spaceBefore=6, spaceAfter=10))
    styles.add(ParagraphStyle("ktheme", fontName="Helvetica-Bold", fontSize=11.5,
                              textColor=colors.HexColor(ACCENT),
                              spaceBefore=10, spaceAfter=4))
    styles.add(ParagraphStyle("kbody", fontName="Helvetica", fontSize=10,
                              leading=14.5, textColor=colors.HexColor(INK),
                              spaceAfter=5))
    styles.add(ParagraphStyle("kbullet", parent=styles["kbody"],
                              leftIndent=14, bulletIndent=4, spaceAfter=3))
    styles.add(ParagraphStyle("kintro", parent=styles["kbody"],
                              spaceBefore=14, spaceAfter=8))
    styles.add(ParagraphStyle("kcaption", fontName="Helvetica-Oblique", fontSize=9,
                              leading=12.5, textColor=colors.HexColor(MUTED),
                              spaceBefore=5, spaceAfter=4))
    styles.add(ParagraphStyle("kref", fontName="Helvetica", fontSize=9.5,
                              leading=13, textColor=colors.HexColor(INK),
                              leftIndent=18, bulletIndent=4, spaceAfter=4))

    def _img(buf: BytesIO, width):
        iw, ih = ImageReader(buf).getSize()
        buf.seek(0)
        return Image(buf, width=width, height=width * ih / iw)

    def chart_block(png, intro, caption):
        return [
            Paragraph(intro, styles["kintro"]),
            KeepTogether([_img(png, 16 * cm), Paragraph(caption, styles["kcaption"])]),
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
        Paragraph("Les mots " + ("du jour" if daily else "de la semaine"),
                  styles["ktheme"]),
        *chart_block(*cloud),
        Spacer(1, 8),
    ]

    story = [
        PageBreak(),  # page 1 is the canvas-drawn cover
        Paragraph("Synthèse du jour" if daily else "Synthèse de la semaine", styles["kh2"]),
        *_md_to_flowables(text, styles),
        PageBreak(),  # charts section starts on a fresh page
        Paragraph("La journée en graphiques" if daily else "La semaine en graphiques", styles["kh2"]),
        *cloud_blocks,
        *rhythm_blocks,
        *chart_block(*sources),
        PageBreak(),
        *chart_block(*cats),
        *refs_blocks,
        Spacer(1, 10),
        Paragraph("Méthodologie", styles["kh2"]),
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
            "La synthèse éditoriale est rédigée par un modèle de langage exécuté "
            "localement, à partir des seuls titres "
            + ("du jour. " if daily else "de la semaine. ")
            + "Elle peut comporter "
            "des imprécisions et ne remplace pas la lecture des articles originaux, "
            "accessibles depuis la section Références.",
            styles["kbody"],
        ),
    ]

    buf = BytesIO()
    SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.8 * cm, bottomMargin=1.8 * cm,
        title=("Le Kiosque · Le point d'actualité du jour" if daily
               else "Le Kiosque · Revue de presse hebdomadaire"),
        author="Le Kiosque",
    ).build(story, onFirstPage=draw_cover, onLaterPages=lambda c, d: None)
    return buf.getvalue()
