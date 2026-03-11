import requests
from bs4 import BeautifulSoup
import re

HEADERS = {"User-Agent": "Mozilla/5.0"}
url = "https://gabonactu.com/category/actualites/politique/"
r = requests.get(url, headers=HEADERS)
soup = BeautifulSoup(r.text, "lxml")

main = soup.find("div", id="primary")
if main:
    print("Found #primary")
    for a in main.find_all("a", href=True):
        href = a["href"]
        if re.search(r"gabonactu\.com/blog/[0-9]{4}/[0-9]{2}/[0-9]{2}", href):
            print(href)
