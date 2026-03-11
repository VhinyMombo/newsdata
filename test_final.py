import requests
from bs4 import BeautifulSoup
import re

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36"}

for url in ["https://gabonactu.com/blog/category/politique/", "https://gabonactu.com/blog/category/economie/"]:
    r = requests.get(url, headers=HEADERS)
    print(f"\n{url} -> status={r.status_code}, len={len(r.text)}")
    if r.status_code == 200:
        soup = BeautifulSoup(r.text, "lxml")
        articles = soup.find_all("article")
        print(f"  article tags: {len(articles)}")
        for a in articles[:3]:
            h2 = a.find("h2", class_="post-title")
            link = h2.find("a")["href"] if h2 and h2.find("a") else "NO LINK"
            print(f"    -> {link}")
        all_links = [a["href"] for a in soup.find_all("a", href=True) if re.search(r"/[0-9]{4}/[0-9]{2}/[0-9]{2}/", a["href"])]
        print(f"  All date-pattern links: {len(all_links)}")
        for l in all_links[:3]:
            print(f"    - {l}")
