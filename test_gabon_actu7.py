import requests
from bs4 import BeautifulSoup
import re

HEADERS = {"User-Agent": "Mozilla/5.0"}
url = "https://gabonactu.com/category/actualites/politique/"
r = requests.get(url, headers=HEADERS)
soup = BeautifulSoup(r.text, "lxml")

main_column = soup.find("div", id="primary")
links = set()
for a in main_column.find_all("a", href=True):
    href = a["href"]
    if href.startswith("/"):
        href = "https://gabonactu.com" + href
    if "facebook.com/sharer" in href or "twitter.com/intent" in href or "whatsapp://" in href or "#" in href:
        continue
    if re.search(r"gabonactu\.com/.*[0-9]{4}/[0-9]{2}/[0-9]{2}", href):
        links.add(href)

for link in links:
    r2 = requests.get(link, headers=HEADERS)
    soup2 = BeautifulSoup(r2.text, "lxml")
    meta_date = soup2.find("meta", property="article:published_time")
    pub_time = meta_date["content"] if meta_date else ""
    print(f"[{pub_time[:10]}] {link}")
    
