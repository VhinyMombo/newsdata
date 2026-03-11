import requests
from bs4 import BeautifulSoup
import re

HEADERS = {"User-Agent": "Mozilla/5.0"}

def test_category(cat_url):
    print(f"\n--- Testing URL: {cat_url} ---")
    r = requests.get(cat_url, headers=HEADERS)
    soup = BeautifulSoup(r.text, "lxml")
    
    links = set()
    
    # GabonActu uses <div id="primary" class="content-area"> for the main column
    main_column = soup.find("div", id="primary")
    
    if main_column:
        for a in main_column.find_all("a", href=True):
            href = a["href"]
            if re.search(r"gabonactu\.com/blog/[0-9]{4}/[0-9]{2}/[0-9]{2}", href):
                links.add(href)
        print(f"Found {len(links)} links in main column (#primary)")
    else:
        print("No #primary column found!")
        
    for i, link in enumerate(list(links)[:5]):
        print(f" {i+1}. {link}")

test_category("https://gabonactu.com/category/actualites/economie/")
test_category("https://gabonactu.com/category/actualites/politique/")
test_category("https://gabonactu.com/category/actualites/sports/")
