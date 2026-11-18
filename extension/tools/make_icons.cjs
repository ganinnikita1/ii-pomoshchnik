// Run with Node.js and sharp: node extension/tools/make_icons.cjs
const path = require('node:path');
const sharp = require('sharp');
const icons = path.resolve(__dirname, '../icons');

(async () => {
  for (const size of [16, 32, 48, 128]) {
    const info = await sharp(path.join(icons, 'mark.svg'), { density: 288 })
      .resize(size, size).png().toFile(path.join(icons, `icon${size}.png`));
    if (info.width !== size || info.height !== size || info.channels !== 4) throw Error(`Invalid ${size}px icon`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
