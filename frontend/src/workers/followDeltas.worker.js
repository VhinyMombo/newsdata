// "Since your last visit" on the front page needs the whole corpus export (data.json,
// about 40 MB once decoded) for a handful of chips. Decoding and scanning it on the
// page itself froze Safari for long enough that clicks on the menu went nowhere:
// here it happens beside the page, which only receives the small result.
import { computeFollowDeltas } from '../utils/categories';

self.onmessage = async ({ data: { follows, lastSeen } }) => {
  try {
    const res = await fetch('/data.json');
    if (!res.ok) throw new Error(`data.json: ${res.status}`);
    const { points = [] } = await res.json();
    let dateMax = null;
    for (const p of points) if (p.date && (!dateMax || p.date > dateMax)) dateMax = p.date;
    self.postMessage({ deltas: computeFollowDeltas(points, follows, lastSeen, dateMax), dateMax });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
