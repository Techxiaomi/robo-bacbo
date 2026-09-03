import sys
import traceback

try:
    from playwright.sync_api import sync_playwright

    print("PLAYWRIGHT SMOKE")
    print("--------------------------------------------")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto("data:text/html,<title>BACBO_OK</title><body>BACBO</body>")
            title = page.title()
            if title != "BACBO_OK":
                raise RuntimeError(f"Titulo inesperado: {title!r}")
        finally:
            browser.close()

    print("[OK] Chromium abriu e fechou em modo headless")
    print("PLAYWRIGHT_SMOKE=PASS")
except Exception:
    traceback.print_exc()
    print("PLAYWRIGHT_SMOKE=FAIL")
    sys.exit(72)
