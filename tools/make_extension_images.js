// Maakt de afbeeldingen voor de Twitch-extensie (logo, taakbalk, discovery, screenshot).
// Gebruik: node tools/make_extension_images.js   (vereist Playwright met Chromium)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets', 'twitch-extension');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'server', 'extension', 'style.css'), 'utf8');

// Eenvoudige trekker (zijaanzicht), viewBox 0 0 100 100.
const tractor = (fill, wheel, hub) => `
  <rect x="20" y="20" width="30" height="30" rx="3" fill="${fill}"/>
  <rect x="25" y="25" width="20" height="16" rx="2" fill="${wheel}" opacity=".55"/>
  <rect x="40" y="42" width="50" height="17" rx="4" fill="${fill}"/>
  <rect x="72" y="27" width="5" height="17" rx="2" fill="${fill}"/>
  <circle cx="34" cy="66" r="22" fill="${wheel}"/><circle cx="34" cy="66" r="9" fill="${hub}"/>
  <circle cx="80" cy="73" r="13" fill="${wheel}"/><circle cx="80" cy="73" r="5" fill="${hub}"/>`;

const scene = (w, h, sunX = 0.82) => `
  <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;inset:0">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b8fd6"/><stop offset="1" stop-color="#bcd8f2"/></linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#sky)"/>
    <circle cx="${w * sunX}" cy="${h * 0.18}" r="${h * 0.07}" fill="#fff6c8"/>
    <path d="M0 ${h * 0.55} Q ${w * 0.3} ${h * 0.45} ${w * 0.6} ${h * 0.52} T ${w} ${h * 0.5} V ${h} H 0 Z" fill="#6f9a3a"/>
    ${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${h * (0.62 + i * 0.045)} L ${w} ${h * (0.6 + i * 0.045)}" stroke="#5c8530" stroke-width="${h * 0.012}"/>`).join('')}
    <path d="M0 ${h * 0.9} H ${w} V ${h} H 0 Z" fill="#8a6a3b"/>
  </svg>`;

const pages = {
  'logo-100x100.png': [100, 100, `
    <div style="width:100px;height:100px;background:linear-gradient(135deg,#2e7d32,#1b4d20);display:flex;align-items:center;justify-content:center">
      <svg width="78" height="78" viewBox="0 0 100 100">${tractor('#ffffff', '#ffffff', '#2e7d32')}
        <path d="M86 6 L74 26 H83 L76 44 L94 20 H85 Z" fill="#ffd54a"/></svg>
    </div>`],
  'taskbar-24x24.png': [24, 24, `
    <svg width="24" height="24" viewBox="0 0 100 100">${tractor('#ffffff', '#ffffff', 'transparent')}</svg>`],
  'discovery-300x200.png': [300, 200, `
    <div style="position:relative;width:300px;height:200px;overflow:hidden;font-family:Inter,Arial,sans-serif">
      ${scene(300, 200)}
      <svg width="120" height="120" viewBox="0 0 100 100" style="position:absolute;left:150px;top:62px">${tractor('#2e7d32', '#222', '#d9a441')}</svg>
      <div style="position:absolute;left:14px;top:16px;right:14px;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.5)">
        <div style="font-size:26px;font-weight:800;line-height:1.05">Twitch<br>Sabotage</div>
        <div style="font-size:12px;font-weight:600;margin-top:6px;max-width:140px">Kijkers saboteren je boerderij met bits</div>
      </div>
    </div>`],
  'screenshot-1024x768.png': [1024, 768, `
    <style>${CSS}</style>
    <div style="position:relative;width:1024px;height:768px;overflow:hidden;background:#0e0e10">
      <div style="position:absolute;left:0;top:0;width:1024px;height:576px;overflow:hidden">
        ${scene(1024, 576, 0.12)}
        <svg width="300" height="300" viewBox="0 0 100 100" style="position:absolute;left:330px;top:230px">${tractor('#2e7d32', '#222', '#d9a441')}</svg>
        <button class="toggle" style="position:absolute;top:24px;right:24px">Sabotage</button>
        <div class="menu floating" style="position:absolute;top:66px;right:24px;width:300px">
          <h1>Saboteer de boer</h1>
          <p class="muted">Kies een actie en betaal met bits. Een paar seconden later gebeurt het in de game.</p>
          <div class="state">De game draait. Kies een actie.</div>
          <div class="list">
            ${[['Motor uit', 'Zet de motor van de trekker uit.', 100], ['Werktuig ontkoppelen', 'Ontkoppelt een willekeurig werktuig.', 200], ['Disco', 'Zwaailichten en knipperende lampen.', 100], ['Boete', 'Haalt geld van de boerderij af.', 300]]
              .map(([n, d, c]) => `<button class="item"><span class="txt"><span class="name">${n}</span><span class="desc">${d}</span></span><span class="cost">${c} bits</span></button>`).join('')}
          </div>
        </div>
        <div class="toast" style="position:absolute;left:24px;right:auto;bottom:24px;width:360px">Kijker7: Motor uit</div>
      </div>
      <div style="position:absolute;left:0;top:576px;width:1024px;height:192px;padding:22px 28px;color:#efeff1;font-family:Inter,Arial,sans-serif">
        <div style="font-size:24px;font-weight:800">Twitch Sabotage voor Farming Simulator 25</div>
        <div style="font-size:15px;color:#adadb8;margin-top:8px;max-width:900px;line-height:1.5">
          Kijkers kiezen een sabotage in het paneel of in beeld en betalen met bits: motor uit, werktuig ontkoppelen, lading kwijt, boete en meer.
          De actie gebeurt een paar seconden later in de game, zichtbaar voor iedereen op de stream.
        </div>
      </div>
    </div>`],
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const [file, [w, h, html]] of Object.entries(pages)) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: file.startsWith('taskbar'), clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
    console.log('gemaakt:', file);
  }
  await browser.close();
})();
