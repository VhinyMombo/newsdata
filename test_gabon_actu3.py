import requests
from bs4 import BeautifulSoup
import re

HEADERS = {"User-Agent": "Mozilla/5.0"}
url = "https://gabonactu.com/category/actualites/politique/"
r = requests.get(url, headers=HEADERS)
soup = BeautifulSoup(r.text, "lxml")

print("--- ALL ARTICLE LINKS ---")
# The problem is the sidebar has "latest news" which is the same across all categories.
# Let's find the main column id or class.
content = soup.find("div", id="content") or soup.find("div", class_=re.compile(r"content|site-main|td-main-content|site-content"))

if content:
    print(f"Found content area: {content.get('id', content.get('class'))}")
    links = set()
    for a in content.find_all("a", href=True):
        href = a["href"]
        if re.search(r"gabonactu\.com/blog/[0-9]{4}/[0-9]{2}/[0-9]{2}", href):
            links.add(href)
    print(f"Found {len(links)} links inside main content")
else:
    print("Could not find main content area")
    
# Let's just print top level layout divs
print("\nTop level divs in body:")
for div in soup.body.find_all("div", recursive=False):
    print(" - class:", div.get("class"), "id:", div.get("id"))
