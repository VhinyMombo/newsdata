"""The report's titles: a dense period stays covered from its first day to its last.
Run: .venv/bin/python tests/test_spread_titles.py"""
import ast
from collections import Counter
from pathlib import Path

# Only this function: importing api.py would load the whole corpus
source = (Path(__file__).parent.parent / "api.py").read_text()
node = next(n for n in ast.parse(source).body
            if isinstance(n, ast.FunctionDef) and n.name == "_spread_titles")
namespace = {}
exec(compile(ast.Module([node], []), "api.py", "exec"), namespace)
spread = namespace["_spread_titles"]

# The week of the outage: the last 300 titles covered only its final two days
DAYS = {"10-30": 130, "10-31": 84, "11-01": 95, "11-02": 164,
        "11-03": 150, "11-04": 131, "11-05": 163, "11-06": 161}
WEEK = [(day, f"source{i % 18:02d}", "", f"titre {i}", f"u{day}{i}")
        for day, count in DAYS.items() for i in range(count)]


def test_short_period_is_untouched():
    rows = WEEK[:300]
    assert spread(rows) == rows


def test_dense_week_keeps_the_limit_and_the_order():
    picked = spread(WEEK)
    assert len(picked) == 300
    assert len({r[4] for r in picked}) == 300
    assert picked == sorted(picked, key=WEEK.index)


def test_every_day_is_covered_in_proportion():
    per_day = Counter(r[0] for r in spread(WEEK))
    for day, count in DAYS.items():
        assert abs(per_day[day] - 300 * count / len(WEEK)) <= 1, (day, per_day[day])


def test_the_last_days_no_longer_crowd_out_the_first():
    assert Counter(r[0] for r in WEEK[-300:])["10-30"] == 0
    assert Counter(r[0] for r in spread(WEEK))["10-30"] >= 30


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
