// Copies the static renderer (HTML/CSS/JS) next to the compiled TypeScript.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'renderer');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
