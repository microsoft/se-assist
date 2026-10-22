const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const publicDir = path.resolve(desktopDir, '..', 'src', 'frontend', 'public');
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function generate() {
  const svg = fs.readFileSync(path.join(publicDir, 'app-icon.svg'), 'utf8');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await window.loadURL('data:text/html,<html></html>');
    const images = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)};
      await image.decode();
      return ${JSON.stringify(iconSizes)}.map(size => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        canvas.getContext('2d').drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    })()`);
    const pngs = images.map((image) => Buffer.from(image, 'base64'));
    const header = Buffer.alloc(6 + iconSizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(iconSizes.length, 4);
    let offset = header.length;
    iconSizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      header[entry] = size === 256 ? 0 : size;
      header[entry + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(pngs[index].length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += pngs[index].length;
    });
    fs.writeFileSync(path.join(desktopDir, 'icon.ico'), Buffer.concat([header, ...pngs]));
    fs.writeFileSync(path.join(desktopDir, 'icon.png'), pngs[iconSizes.indexOf(256)]);
    fs.writeFileSync(path.join(publicDir, 'favicon.png'), pngs[iconSizes.indexOf(64)]);
    console.log(`Generated Saffron Relay app icons (${iconSizes.join(', ')}px).`);
  } finally {
    window.destroy();
  }
}

app.whenReady().then(generate).then(() => app.quit(), (error) => {
  console.error(`App icon generation failed: ${error.stack || error}`);
  app.exit(1);
});
