/*!
 * earth_frame.js — بيتحقن (عن طريق Playwright add_init_script) جوه Google Earth
 * لما يكون مفتوح كـ iframe جوه دليل المراجعة (وضع «تغيير الزمن»).
 *
 * Google Earth Web مبني بـ Flutter (الواجهة مرسومة على canvas)، فالكود ده:
 *  - بيشغّل شجرة الـ accessibility بتاعة Flutter عشان يعرف مكان كل زرار باسمه.
 *  - بيحرّك الكاميرا من غير إعادة تحميل (history.pushState + popstate).
 *  - بيضغط على أزرار «أقدم/أحدث» بأحداث Pointer.
 *  - بيقرا التاريخ الحالي وارتفاع الأرض (للمطابقة الدقيقة مع الشيب فايل).
 * والتواصل مع الصفحة الأم بـ postMessage بس.
 */
(function () {
  if (location.hostname !== "earth.google.com") return;
  if (window.top === window && !window.__ETV_TEST) return;   // شغال بس جوه iframe
  if (window.__ETV_FRAME) return;
  window.__ETV_FRAME = true;

  const PARENT = window.top === window ? window : window.parent;
  const post = (msg) => { try { PARENT.postMessage(Object.assign({ etv: true }, msg), "*"); } catch (e) {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const DATE_RX = /^([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})$/;
  const toISO = (label) => {
    const m = DATE_RX.exec(label || "");
    if (!m) return null;
    const mo = MONTHS[m[1].toLowerCase()];
    return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
  };

  // ───────────── Flutter semantics ─────────────
  function enableSemantics() {
    if (document.querySelector("flt-semantics-host flt-semantics")) return true;
    const p = document.querySelector("flt-semantics-placeholder");
    if (p) p.click();
    return false;
  }
  const label = (e) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim();
  const visible = (r) => r && r.width > 0 && r.height > 0;

  function find(rx) {
    let best = null, area = Infinity;
    for (const e of document.querySelectorAll("flt-semantics")) {
      const r = e.getBoundingClientRect();
      if (!visible(r)) continue;
      if (!rx.test(label(e))) continue;
      const a = r.width * r.height;
      if (a < area) {
        area = a;
        best = { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
                 disabled: e.getAttribute("aria-disabled") === "true" };
      }
    }
    return best;
  }

  function currentDateLabel() {
    for (const s of document.querySelectorAll("flt-semantics-host span, flt-semantics-host flt-semantics")) {
      if (s.children.length) continue;
      const t = s.textContent.trim();
      if (DATE_RX.test(t)) {
        const r = s.getBoundingClientRect();
        if (visible(r) && r.y < 300) return t;
      }
    }
    return null;
  }

  // ضغطة (Flutter بيستقبل أحداث Pointer على flutter-view)
  function tap(p) {
    const fv = document.querySelector("flutter-view") || document.body;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y,
                pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, view: window };
    fv.dispatchEvent(new PointerEvent("pointermove", { ...o, buttons: 0 }));
    fv.dispatchEvent(new PointerEvent("pointerdown", { ...o, buttons: 1 }));
    fv.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
  }
  function hover(x, y) {
    const fv = document.querySelector("flutter-view") || document.body;
    fv.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0, view: window }));
  }

  // ───────────── URL / camera ─────────────
  // data= بتاعة Google Earth: protobuf فيه «الصور التاريخية شغالة» + التاريخ (YYYY-MM-DD)
  function histData(date) {
    const enc = new TextEncoder().encode(date || "");
    const hist = [0x08, 0x01, 0x12, enc.length, ...enc, 0x18, 0x01];
    const f1 = [0x2a, hist.length, ...hist, 0x42, 0x02, 0x08, 0x01];
    const tail = [0x42, 0x02, 0x08, 0x00, 0x4a, 0x0d, 0x08, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0x01, 0x10, 0x00];
    const all = [0x0a, f1.length, ...f1, ...tail];
    return btoa(String.fromCharCode(...all)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  window.__etvHistData = histData;

  let lastDate = null;   // آخر تاريخ ISO معروض
  let camera = null;     // {lat,lng,a,d}

  function go(cam, date) {
    camera = cam;
    const f = (v, n) => Number(v).toFixed(n);
    const path = `/web/@${f(cam.lat, 8)},${f(cam.lng, 8)},${f(cam.a, 2)}a,${f(cam.d, 2)}d,35y,0h,0t,0r/data=${histData(date || "")}`;
    history.pushState(null, "", path + location.search);
    dispatchEvent(new PopStateEvent("popstate", { state: null }));
  }

  // ───────────── State loop ─────────────
  let lastHistTap = 0;
  function dismissPopups() {
    for (const e of document.querySelectorAll("flt-semantics")) {
      const l = label(e);
      if (!/^(dismiss|got it|no thanks|not now|skip|start exploring|continue)$/i.test(l)) continue;
      const r = e.getBoundingClientRect();
      if (visible(r)) tap({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    }
    const toast = find(/temporarily disables 3D/i);
    if (toast) {
      for (const e of document.querySelectorAll("flt-semantics")) {
        if (!/^close$/i.test(label(e))) continue;
        const r = e.getBoundingClientRect();
        const c = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        if (visible(r) && c.x >= toast.left && c.x <= toast.right && c.y >= toast.top && c.y <= toast.bottom) tap(c);
      }
    }
  }

  // ارتفاع الأزرار اللي تحت (البوصلة، الزووم، شريط الإحداثيات…) عشان تتقص
  function footerHeight() {
    let minTop = Infinity;
    for (const e of document.querySelectorAll("flt-semantics-host flt-semantics, flt-semantics-host span")) {
      const r = e.getBoundingClientRect();
      if (!visible(r) || r.height > 160 || r.top < innerHeight * 0.55) continue;
      minTop = Math.min(minTop, r.top);
    }
    return isFinite(minTop) ? Math.ceil(innerHeight - minTop + 8) : 0;
  }

  function sampleLabels() {
    const out = [];
    for (const e of document.querySelectorAll("flt-semantics")) {
      const r = e.getBoundingClientRect();
      if (!visible(r) || e.children.length > 3) continue;
      const l = label(e).slice(0, 40);
      if (l && !out.includes(l)) out.push(l);
      if (out.length >= 15) break;
    }
    return out;
  }

  function state() {
    const sem = enableSemantics();
    const show = find(/^show historical imagery$/i);
    const hide = find(/^hide historical imagery$/i);
    const older = find(/^older images$/i);
    const newer = find(/^newer images$/i);
    const closeStrip = find(/^(close|collapse)$/i);
    const dl = hide ? currentDateLabel() : null;
    if (dl) lastDate = toISO(dl) || lastDate;
    // الجزء اللي فوق (شريط الأدوات + شريط التواريخ) — بيتخبّى بقص الـ iframe
    let uiBottom = 0;
    for (const n of [show, hide, older, newer, closeStrip]) if (n && n.top < 200) uiBottom = Math.max(uiBottom, n.bottom);
    return {
      ready: sem && !!(show || hide),
      hist: !!hide,
      dateLabel: dl,
      date: dl ? toISO(dl) : null,
      canOlder: !!older && !older.disabled,
      canNewer: !!newer && !newer.disabled,
      uiBottom: uiBottom ? Math.ceil(uiBottom + 10) : 0,
      uiFooter: footerHeight(),
      flightDone,
      vw: innerWidth, vh: innerHeight,
      // للتشخيص: أسماء أول أزرار ظاهرة لو لسه مش جاهز
      labels: (sem && !hide) ? sampleLabels() : undefined,
      semPlaceholder: !!document.querySelector("flt-semantics-placeholder"),
      flutter: !!document.querySelector("flutter-view"),
      url: location.pathname.slice(0, 80)
    };
  }

  let busy = false;       // أثناء المسح أو قياس الارتفاع

  // ── قفل «أنيميشن الطيران» في إعدادات Google Earth ──
  // من غيره Earth بيطير للمكان الجديد في 1–2 ثانية، ووقتها الصورة بتبان بمقاس غلط تحت الشيب فايل.
  let flightDone = false, flightTries = 0;
  const findSwitch = (rx) => [...document.querySelectorAll("flt-semantics[role=switch]")]
    .find((e) => rx.test(label(e)) && visible(e.getBoundingClientRect()));
  async function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(120); }
    return null;
  }
  async function disableFlight() {
    if (flightDone || busy) return;
    busy = true; flightTries++;
    let shownMenu = false;
    try {
      let st = find(/^settings$/i);
      if (!st) {
        const show = find(/^show the menu bar$/i);
        if (show) { tap(show); shownMenu = true; st = await waitFor(() => find(/^settings$/i), 2500); }
      }
      if (!st) return;
      tap(st);
      let sw = await waitFor(() => findSwitch(/^turn on flight animations/i), 4000);
      if (sw) {
        await sleep(800);                               // استنى النافذة تفتح وحالة السويتش تتحدّث
        sw = findSwitch(/^turn on flight animations/i) || sw;
        if (sw.getAttribute("aria-checked") === "true") {
          const r = sw.getBoundingClientRect();
          tap({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          await sleep(1000);
        }
        const again = findSwitch(/^turn on flight animations/i);
        flightDone = !again || again.getAttribute("aria-checked") !== "true";
      }
      const done = await waitFor(() => find(/^done$/i), 1500);
      if (done) tap(done);
      await sleep(600);
    } catch (e) {
    } finally {
      if (shownMenu) { const hide = await waitFor(() => find(/^hide the menu bar$/i), 1500); if (hide) tap(hide); }
      if (flightTries >= 2) flightDone = true;        // مانقدرش نقفله؟ نكمّل عادي
      busy = false;
    }
  }
  async function loop() {
    try {
      const s = state();
      if (s.ready && !busy) {
        dismissPopups();
        if (s.hist && !flightDone) disableFlight();
        if (!s.hist && Date.now() - lastHistTap > 4000) {        // الصور التاريخية لازم تفضل شغالة
          const b = find(/^show historical imagery$/i);
          if (b) { tap(b); lastHistTap = Date.now(); }
        }
      }
      post({ type: "state", ...s, busy });
    } catch (e) {}
    setTimeout(loop, 700);
  }

  async function waitDateChange(prev, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const l = currentDateLabel();
      if (l && l !== prev) return l;
      await sleep(40);
    }
    return currentDateLabel();
  }

  async function step(dir) {
    const b = find(dir === "older" ? /^older images$/i : /^newer images$/i);
    if (!b || b.disabled) return null;
    const prev = currentDateLabel();
    tap(b);
    const l = await waitDateChange(prev, 4000);
    return l ? toISO(l) : null;
  }

  // مسح كل تواريخ الصور المتاحة للمكان الحالي
  let stopScan = false;
  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    for (let i = 0; i < 100 && busy; i++) await sleep(150);   // استنى قياس الارتفاع/الإعدادات يخلصوا
    busy = true; stopScan = false;
    const start = lastDate;
    const dates = [];
    try {
      for (let i = 0; i < 120 && !stopScan; i++) { if (!(await step("newer"))) break; }
      const first = toISO(currentDateLabel());
      if (first) dates.push(first);
      post({ type: "scan", dates: dates.slice(), done: false });
      for (let i = 0; i < 200 && !stopScan; i++) {
        const d = await step("older");
        if (!d) break;
        if (!dates.includes(d)) dates.push(d);
        post({ type: "scan", dates: dates.slice(), done: false });
      }
    } finally {
      if (camera && start) { go(camera, start); await waitDateChange(null, 1500); }
      busy = false; scanning = false;
      post({ type: "scan", dates, done: true });
    }
  }

  // ارتفاع الأرض عند نص الشاشة (من قراءة «Cursor elevation» بتاعة Google Earth)
  // ── هل Google Earth وصل للكاميرا المطلوبة؟ ──
  // بنقرا من Earth نفسه: إحداثيات نص الشاشة (Cursor latitude/longitude) وارتفاع الكاميرا.
  let camToken = 0;
  const DMS_RX = /(\d+)°(\d+)'([\d.]+)"([NS])\s*(\d+)°(\d+)'([\d.]+)"([EW])/;
  function readCursorLatLng() {
    const host = document.querySelector("flt-semantics-host");
    const t = host ? host.textContent || "" : "";
    const i = t.indexOf("Cursor latitude");
    if (i < 0) return null;
    const m = DMS_RX.exec(t.slice(i, i + 120));
    if (!m) return null;
    let lat = +m[1] + m[2] / 60 + m[3] / 3600, lng = +m[5] + m[6] / 60 + m[7] / 3600;
    if (m[4] === "S") lat = -lat;
    if (m[8] === "W") lng = -lng;
    return { lat, lng };
  }
  function readCameraAlt() {
    const host = document.querySelector("flt-semantics-host");
    const m = /Camera:\s*([\d,.]+)\s*(km|m)(?![a-z])/.exec(host ? host.textContent || "" : "");
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ""));
    return m[2] === "km" ? v * 1000 : v;
  }
  async function waitCamera(cam, token, ms) {
    const t0 = Date.now();
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const mpp = cam.d * 2 * Math.tan(17.5 * Math.PI / 180) / innerHeight;   // متر لكل بكسل
    const tolM = Math.max(0.4, 1.5 * mpp);
    const wantAlt = cam.a + cam.d;
    let k = 0, okCount = 0;
    await sleep(30);
    while (Date.now() - t0 < ms) {
      if (token !== camToken) return false;
      hover(cx + (k++ % 2) * 0.01, cy);
      await sleep(45);
      const ll = readCursorLatLng();
      const alt = readCameraAlt();
      if (ll) {
        const dy = (ll.lat - cam.lat) * 111320;
        const dx = (ll.lng - cam.lng) * 111320 * Math.cos(cam.lat * Math.PI / 180);
        const posOk = Math.hypot(dx, dy) <= tolM;
        const altOk = alt == null || Math.abs(alt - wantAlt) <= Math.max(1.5, wantAlt * 0.01);
        if (posOk && altOk) { if (++okCount >= 2) return true; } else okCount = 0;
      }
    }
    return false;
  }

  function readLoadProgress() {
    const host = document.querySelector("flt-semantics-host");
    const m = /loading current satellite imagery\s*(\d+)\s*%/i.exec(host ? host.textContent || "" : "");
    return m ? +m[1] : null;
  }
  async function waitTiles(token, ms) {
    const t0 = Date.now();
    await sleep(150);
    while (Date.now() - t0 < ms) {
      if (token !== camToken) return;
      const p = readLoadProgress();
      if (p == null || p >= 100) return;
      await sleep(100);
    }
  }

  function readElevation() {
    const host = document.querySelector("flt-semantics-host");
    if (!host) return null;
    const m = /Cursor elevation[^\d-]*(-?[\d,.]+)\s*(m|ft)/i.exec(host.textContent || "");
    if (!m) return null;
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (m[2].toLowerCase() === "ft") v *= 0.3048;
    return isFinite(v) ? v : null;
  }
  async function measureElevation(cx, cy) {
    if (busy) return null;
    busy = true;
    try {
      const pts = [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]];
      const vals = [];
      for (const [dx, dy] of pts) {
        for (let k = 0; k < 2; k++) { hover(cx + dx + k * 0.3, cy + dy); await sleep(350); }
        const v = readElevation();
        if (v != null) vals.push(v);
      }
      hover(-10, -10);
      if (!vals.length) return null;
      vals.sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)];
    } finally { busy = false; }
  }

  // ───────────── Messages from index.html ─────────────
  window.addEventListener("message", async (e) => {
    if (e.source !== PARENT || !e.data || e.data.etvCmd == null) return;
    const m = e.data;
    try {
      switch (m.etvCmd) {
        case "cam": {
          const token = ++camToken;
          go(m.cam, m.date || lastDate);
          // استنى لحد ما Google Earth يوصل فعلًا للكاميرا الجديدة (مش وقت ثابت)
          const arrived = await waitCamera(m.cam, token, m.waitTiles ? 4000 : 2500);
          if (token !== camToken) break;               // جه أمر أحدث — ده خلاص مالوش لازمة
          if (m.waitTiles) await waitTiles(token, 1800);   // النسخة المستخبية: استنى الصور تتحمّل قبل ما تظهر
          await Promise.race([frames(2), sleep(120)]);
          post({ type: "camAck", id: m.id, arrived });
          break;
        }
        case "date": {
          if (!camera) break;
          const prev = currentDateLabel();
          if (toISO(prev) === m.date) { post({ type: "dateAck", date: m.date }); break; }
          go(camera, m.date);
          const l = await waitDateChange(prev, 3000);
          post({ type: "dateAck", date: toISO(l) || m.date });
          break;
        }
        case "older":
        case "newer": {
          const d = await step(m.etvCmd);
          post({ type: "dateAck", date: d });
          break;
        }
        case "scan": scan(); break;
        case "scanStop": stopScan = true; break;
        case "elev": {
          const v = await measureElevation(innerWidth / 2, innerHeight / 2);
          post({ type: "elev", id: m.id, elev: v });
          break;
        }
      }
    } catch (err) {
      post({ type: "error", cmd: m.etvCmd, message: String(err && err.message || err) });
    }
  });

  let started = false;
  const start = () => { if (!started) { started = true; setTimeout(loop, 500); } };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start); else start();
})();
