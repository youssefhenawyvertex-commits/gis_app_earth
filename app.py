"""
Smart Review Guide — launcher
-----------------------------
بيفتح «دليل المراجعة الذكي» (index.html) في نافذة Chromium (Playwright)،
ومعاه ميزة «تغيير الزمن»: Google Earth بالصور التاريخية تحت الشيب فايل.

Google Earth مايتفتحش جوه صفحة تانية في المتصفح العادي، فالبرنامج ده:
  1) بيقدّم index.html من الفولدر ده بهيدرز العزل (crossOriginIsolated) اللي Google Earth محتاجها.
  2) بيسمح لـ Google Earth يتفتح جوه الدليل (بيشيل X-Frame-Options من صفحته بس، جوه النافذة دي بس).
  3) بيحط كود الربط earth_frame.js جوه Google Earth عشان الدليل يتحكم في الكاميرا والتاريخ.

التشغيل:  python app.py   (أو run.bat / run.sh)
"""
import asyncio
import json
import mimetypes
import os
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE_DIR = Path(__file__).resolve().parent
# ‎*.localhost بيتعامل كـ «آمن» في كروم (لازم عشان crossOriginIsolated) — ومفيش سيرفر حقيقي، Playwright بيرد بنفسه
APP_ORIGIN = "http://review-guide.localhost"
APP_URL = APP_ORIGIN + "/index.html"
PROFILE_DIR = Path(os.getenv("APP_PROFILE_DIR", BASE_DIR / "app_profile")).resolve()
EARTH_FRAME_FILE = BASE_DIR / "earth_frame.js"

# Google Earth محتاج الصفحة تبقى crossOriginIsolated
ISOLATION_HEADERS = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "credentialless",
}

state = {"ctx": None, "injected": 0}


def short(e: Exception) -> str:
    return (str(e).strip().splitlines() or [type(e).__name__])[0][:300]


# ───────────────────────── صفحة الدليل (ملفات الفولدر ده) ─────────────────────────
async def app_route(route, request):
    path = request.url[len(APP_ORIGIN):].split("?")[0].split("#")[0] or "/"
    if path == "/":
        path = "/index.html"
    if path == "/earth_debug":
        body = json.dumps(await earth_debug(), ensure_ascii=False)
        return await route.fulfill(status=200, content_type="application/json; charset=utf-8", body=body)
    f = (BASE_DIR / path.lstrip("/")).resolve()
    if BASE_DIR not in f.parents or not f.is_file():
        # config.js اختياري — لو مش موجود نرجّع ملف فاضي
        if path == "/config.js":
            return await route.fulfill(status=200, content_type="application/javascript", body="window.APP_CONFIG = window.APP_CONFIG || {};")
        return await route.fulfill(status=404, body="not found")
    ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype.endswith("javascript") or ctype.endswith("json"):
        ctype += "; charset=utf-8"
    headers = {"content-type": ctype, "cache-control": "no-store", **ISOLATION_HEADERS}
    await route.fulfill(status=200, headers=headers, body=f.read_bytes())


# ───────────────────────── Google Earth جوه الدليل ─────────────────────────
def inject_earth_html(html: str, csp: str) -> str:
    """بيحط <script> فيه earth_frame.js في أول الـ <head> بتاع Google Earth (بنفس nonce الـ CSP)."""
    m = re.search(r"'nonce-([^']+)'", csp or "")
    nonce = f' nonce="{m.group(1)}"' if m else ""
    js = EARTH_FRAME_FILE.read_text(encoding="utf-8").replace("</", "<\\/")
    tag = f"<script{nonce}>{js}</script>"
    hm = re.search(r"<head[^>]*>", html, re.I)
    return html[:hm.end()] + tag + html[hm.end():] if hm else tag + html


async def earth_route(route, request):
    if request.resource_type != "document":
        return await route.continue_()
    try:
        resp = await route.fetch()
    except Exception as e:
        print("⚠️  تعذّر فتح Google Earth:", short(e))
        return await route.continue_()
    print(f"🌍 Google Earth بيتفتح جوه الدليل (HTTP {resp.status})")
    drop = {"x-frame-options", "content-length", "content-encoding"}
    headers = {k: v for k, v in resp.headers.items() if k.lower() not in drop}
    for k in list(headers):
        if k.lower() in ("content-security-policy", "content-security-policy-report-only"):
            headers[k] = ";".join(d for d in headers[k].split(";") if not d.strip().lower().startswith("frame-ancestors"))
    headers["cross-origin-resource-policy"] = "cross-origin"
    # جوجل بتبعت COEP مع التنقل العادي بس — من غيره المتصفح بيرفض يعرض Google Earth جوه الدليل
    if not any(k.lower() == "cross-origin-embedder-policy" for k in headers):
        headers["cross-origin-embedder-policy"] = "credentialless"
    body = await resp.body()
    if "html" in headers.get("content-type", "") and EARTH_FRAME_FILE.exists():
        try:
            body = inject_earth_html(body.decode("utf-8", "replace"), headers.get("content-security-policy", "")).encode("utf-8")
            state["injected"] += 1
        except Exception as e:
            print("⚠️  تعذّر حقن كود الربط:", short(e))
    await route.fulfill(status=resp.status, headers=headers, body=body)


def is_earth(url: str) -> bool:
    return url.startswith("https://earth.google.com/")


async def inject_later(frame, delay=2.0):
    """شبكة أمان: لو كود الربط مااشتغلش جوه Google Earth، نحقنه مباشرة."""
    await asyncio.sleep(delay)
    try:
        if frame.is_detached() or not is_earth(frame.url):
            return
        if await frame.evaluate("() => !!window.__ETV_FRAME"):
            return
        await frame.evaluate(EARTH_FRAME_FILE.read_text(encoding="utf-8"))
        print("🔧 كود الربط اتحقن في Google Earth مباشرة")
    except Exception as e:
        print("⚠️  تعذّر حقن كود الربط مباشرة:", short(e))


def watch_frames(page):
    def on_nav(frame):
        if frame.parent_frame is not None and is_earth(frame.url):
            asyncio.create_task(inject_later(frame))
    page.on("framenavigated", on_nav)


async def earth_debug():
    """تشخيص: Google Earth عارض إيه جوه الدليل (الصفحة بتسأل /earth_debug لو حصلت مشكلة)."""
    out = {"ok": True, "injected_html": state["injected"], "frames": [], "all_frames": []}
    ctx = state["ctx"]
    if not ctx:
        return {**out, "ok": False}
    for pg in ctx.pages:
        for fr in pg.frames:
            out["all_frames"].append(fr.url[:120])
            if not is_earth(fr.url):
                continue
            info = {"url": fr.url[:160]}
            try:
                info.update(await fr.evaluate("""() => ({
                    etv: !!window.__ETV_FRAME, coi: self.crossOriginIsolated, title: document.title,
                    flutter: !!document.querySelector('flutter-view'),
                    semantics: document.querySelectorAll('flt-semantics').length,
                    text: (document.body ? document.body.innerText : '').replace(/[ \\n\\t]+/g, ' ').slice(0, 300)
                })"""))
            except Exception as e:
                info["error"] = short(e)
            out["frames"].append(info)
    return out


# ───────────────────────── التشغيل ─────────────────────────
async def main():
    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=os.getenv("APP_HEADLESS", "").lower() in ("1", "true"),
            no_viewport=True,
            accept_downloads=True,
            ignore_default_args=["--enable-automation"],
            args=["--start-maximized", "--disable-features=DownloadBubble,DownloadBubbleV2"],
            locale="en-US",               # Google Earth بيتعرف على أزراره بأساميها الإنجليزي
            service_workers="block",      # الـ service workers ممكن تتخطى الـ route بتاع Google Earth
        )
        state["ctx"] = ctx
        await ctx.route(APP_ORIGIN + "/**", app_route)
        await ctx.route("https://earth.google.com/**", earth_route)
        if EARTH_FRAME_FILE.exists():
            await ctx.add_init_script(path=str(EARTH_FRAME_FILE))
        for pg in ctx.pages:
            watch_frames(pg)
        ctx.on("page", watch_frames)

        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(APP_URL)
        print("✅ دليل المراجعة شغال — اقفل النافذة عشان تخرج.")

        closed = asyncio.Event()
        ctx.on("close", lambda _c: closed.set())
        await closed.wait()


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
