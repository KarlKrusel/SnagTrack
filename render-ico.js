// Render appicon.svg to multi-size PNGs, then combine into favicon.ico
// Build tool — not shipped.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const svg = fs.readFileSync(path.join(ROOT, 'appicon.svg'), 'utf8');
const tmp = path.join(ROOT, '.ico-png');
fs.mkdirSync(tmp, { recursive: true });
const sizes = [256, 128, 64, 48, 32, 16];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const files = [];
  for (const s of sizes) {
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(
      `<!doctype html><meta charset=utf8><style>*{margin:0;padding:0}html,body{width:${s}px;height:${s}px;background:transparent}svg{width:${s}px;height:${s}px;display:block}</style>${svg}`
    );
    const el = await page.$('svg');
    const out = path.join(tmp, `${s}.png`);
    await el.screenshot({ path: out, omitBackground: true });
    files.push(out);
    console.log('  rendered', s + 'px');
  }
  await browser.close();

  // Combine into a multi-resolution .ico via the global png-to-ico module
  const gRoot = execSync('npm root -g').toString().trim();
  const _ptm = require(path.join(gRoot, 'png-to-ico'));
  const pngToIco = typeof _ptm === 'function' ? _ptm : (_ptm.default || _ptm.pngToIco);
  const icoPath = path.join(ROOT, 'favicon.ico');
  const ico = await pngToIco(files);
  fs.writeFileSync(icoPath, ico);
  console.log('  wrote', icoPath, '(' + ico.length + ' bytes)');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error('ICO render failed:', e.message); process.exit(1); });
