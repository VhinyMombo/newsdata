"""
lekiosque_theme.py — reusable lets-plot theme for Le Kiosque figures.

Modeled on the BBC data-journalism cookbook (bbc_style()): headline and
subtitle inside the figure, one light grid along the value axis, no axis
titles, muted tick labels, and a source line bottom-right.

Usage:
    from lekiosque_theme import lekiosque_theme, to_png, SOURCE_LINE
    p = (ggplot(data) + geom_bar(...)
         + labs(title="...", subtitle="...", caption=SOURCE_LINE)
         + lekiosque_theme(grid="y"))
    png = to_png(p, width=900, height=380)
"""

from __future__ import annotations

import os
import tempfile
from io import BytesIO

INK = "#1c241f"
MUTED = "#6e7a72"
ACCENT = "#166f43"
ACCENT_SOFT = "#a7c6b4"
GRID = "#e7e5db"

FONT = "Helvetica"

SOURCE_LINE = "Source : Le Kiosque · corpus de la presse gabonaise en ligne"

_setup_done = False


def _setup() -> None:
    global _setup_done
    if not _setup_done:
        from lets_plot import LetsPlot
        LetsPlot.setup_html(no_js=True)
        _setup_done = True


def lekiosque_theme(grid: str = "y"):
    """BBC-style theme. grid="y" draws horizontal lines (vertical bars,
    lines); grid="x" draws vertical lines (horizontal bars); grid="none"
    for direct-labeled figures that carry no value axis at all."""
    from lets_plot import element_blank, element_line, element_text, theme

    _setup()
    grid_line = element_line(color=GRID, size=0.7)
    return theme(
        plot_title=element_text(family=FONT, size=19, face="bold", color=INK),
        plot_subtitle=element_text(family=FONT, size=14, color=MUTED),
        plot_caption=element_text(family=FONT, size=11, color=MUTED),
        text=element_text(family=FONT, color=INK),
        axis_title=element_blank(),
        axis_text=element_text(family=FONT, size=13, color=MUTED),
        axis_ticks=element_blank(),
        axis_line=element_blank(),
        panel_grid_major_y=grid_line if grid == "y" else element_blank(),
        panel_grid_major_x=grid_line if grid == "x" else element_blank(),
        panel_grid_minor=element_blank(),
        panel_background=element_blank(),
        legend_position="none",
    )


def to_png(plot, width: int, height: int, scale: float = 2.0) -> BytesIO:
    """Render a lets-plot figure to PNG bytes at `width`×`height` CSS px
    (rasterized at `scale`× for print sharpness)."""
    from lets_plot import ggsave, ggsize

    _setup()
    with tempfile.TemporaryDirectory() as tmp:
        out = ggsave(plot + ggsize(width, height), filename="fig.png",
                     path=tmp, scale=scale)
        with open(out, "rb") as f:
            return BytesIO(f.read())
