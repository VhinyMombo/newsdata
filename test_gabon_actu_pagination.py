import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36"}

print("Fetching category page...")
r = requests.get("https://gabonactu.com/category/actualites/politique/", headers=HEADERS)
soup = BeautifulSoup(r.text, "lxml")

print("Pagination Check:")
nav = soup.find("nav", class_="navigation pagination")
if nav:
    print("Found navigation block.")
    for a in nav.find_all("a", href=True):
        print(" - pagination link:", a['href'])
else:
    # Alternative check
    pages = soup.find_all("a", class_="page-numbers")
    for p in pages:
        print(" - page link:", p["href"] if p.has_attr("href") else p.get_text())

# Also test if appending /page/2/ works just in case
print("\nTesting /page/2/ directly:")
r = requests.get("https://gabonactu.com/category/actualites/politique/page/2/", headers=HEADERS)
if r.status_code == 200:
    print("  /page/2/ is a 200 OK")
else:
    print(f"  /page/2/ failed with {r.status_code}")

