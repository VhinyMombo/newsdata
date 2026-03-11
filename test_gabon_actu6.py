import requests
from bs4 import BeautifulSoup
import re

HEADERS = {"User-Agent": "Mozilla/5.0"}
url = "https://gabonactu.com/blog/2026/03/10/meyo-kye-trafic-de-stupefiants-michel-mermoz-obame-retourne-en-prison/"
r = requests.get(url, headers=HEADERS)
soup = BeautifulSoup(r.text, "lxml")

pub_meta = soup.find("meta", property="article:published_time")
print(f"Published time (meta): {pub_meta['content'] if pub_meta else 'NOT FOUND'}")

if not pub_meta:
    # Maybe it uses something else?
    for meta in soup.find_all("meta"):
        if "time" in str(meta) or "date" in str(meta):
            print("Found other date meta:", meta)
            
    time_tag = soup.find("time")
    print("Found time tag:", time_tag)
    
title_meta = soup.find("h1")
print(f"Title: {title_meta.get_text(strip=True) if title_meta else 'NOT FOUND'}")
