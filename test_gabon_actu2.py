import requests
from bs4 import BeautifulSoup
import re

HEADERS = {"User-Agent": "Mozilla/5.0"}

def test_category(cat_url):
    print(f"\n--- Testing URL: {cat_url} ---")
    r = requests.get(cat_url, headers=HEADERS)
    soup = BeautifulSoup(r.text, "lxml")
    
    links = set()
    # Try finding the designated main content block first, GabonActu uses TagDiv themes
    main_column = soup.find("div", class_=re.compile(r"tdc-row|td-ss-main-content|tdb_module_loop"))
    
    # Actually, a safer bet is to look for article containers
    modules = soup.find_all("div", class_=re.compile(r"tdb_module_loop|td_module_|td-module-"))
    if modules:
        print(f"Found {len(modules)} article modules")
        for module in modules:
            for a in module.find_all("a", href=True):
                href = a["href"]
                if re.search(r"gabonactu\.com/blog/[0-9]{4}/[0-9]{2}/[0-9]{2}", href):
                    links.add(href)
    else:
        print("No modules found")
        
    for i, link in enumerate(list(links)[:5]):
        print(f" {i+1}. {link}")
    print(f"Total links found: {len(links)}")

test_category("https://gabonactu.com/category/actualites/economie/")
test_category("https://gabonactu.com/category/actualites/politique/")
test_category("https://gabonactu.com/category/actualites/sports/")
