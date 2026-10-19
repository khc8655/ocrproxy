"""Narrow-viewport regression: no admin tab may widen the page past the viewport.

Reuses the backend contract harness (same VM + EdgeOne local servers and scenarios),
then opens each top tab at 1280 / 768 / 390 px in real Chromium and asserts
document.scrollWidth <= innerWidth + 2 on both deployments.
Wide tables are allowed to scroll inside their own .table-wrap; that does not count.
"""
import asyncio, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_backend_contract as T

WIDTHS = (1280, 768, 390)
FAILS = []

async def check(b):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        br = await p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox"])
        pg = await br.new_page(viewport={"width": 1280, "height": 900})
        await pg.goto(b.base + b.console_path)
        await pg.fill("#loginKey", T.ADMIN_PW)
        await pg.click("#loginOverlay button[type=submit]")
        await asyncio.sleep(2.5)
        tabs = await pg.evaluate("Array.from(document.querySelectorAll('#topNav button')).filter(x=>x.offsetParent).map(x=>x.innerText.trim())")
        for w in WIDTHS:
            await pg.set_viewport_size({"width": w, "height": 900})
            for t in tabs:
                await pg.evaluate("t=>Array.from(document.querySelectorAll('#topNav button')).find(x=>x.innerText.trim()===t).click()", t)
                await asyncio.sleep(0.3)
                over = await pg.evaluate("document.documentElement.scrollWidth - innerWidth")
                ok = over <= 2
                print(f"  {'✓' if ok else '✗'} {b.name} {w}px {t}: overflow={over}px")
                if not ok:
                    FAILS.append(f"{b.name} {w}px {t} +{over}px")
        await br.close()

_contract_drive = T.drive

async def drive(b, mock_url):
    await _contract_drive(b, mock_url)   # seed real calls/state exactly like the contract test
    await check(b)

if __name__ == "__main__":
    T.drive = drive
    rc = T.main()
    if FAILS:
        print("Horizontal overflow:", FAILS)
    sys.exit(1 if (rc or FAILS) else 0)
