import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outPath = path.join(rootDir, 'dist', 'ocean-himalayas-3d.html');

async function buildSingleFile() {
  const [indexHtml, rawCss, jsResult] = await Promise.all([
    fs.readFile(path.join(rootDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(rootDir, 'src', 'ui', 'styles.css'), 'utf8'),
    esbuild.build({
      entryPoints: [path.join(rootDir, 'src', 'main.js')],
      bundle: true,
      format: 'iife',
      minify: true,
      target: ['es2020'],
      write: false,
      legalComments: 'none',
      plugins: [
        {
          name: 'ignore-css-imports',
          setup(build) {
            build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
          },
        },
      ],
    }),
  ]);

  const cssResult = await esbuild.transform(rawCss, {
    loader: 'css',
    minify: true,
  });

  const safeCss = cssResult.code.replace(/<\/style/gi, '<\\/style');
  const safeJs = jsResult.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

  let html = indexHtml;
  html = html.replace(
    '</head>',
    () => `  <style>${safeCss}</style>\n  </head>`
  );
  html = html.replace(
    /<script\s+type="module"\s+src="\/src\/main\.js"><\/script>/,
    () => `<script>${safeJs}</script>`
  );

  html = `<!-- Ocean Himalayas 3D Standalone Single-File Build -->\n${html}`;

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html, 'utf8');

  const stat = await fs.stat(outPath);
  console.log(
    `Built standalone single-file HTML: ${outPath} (${(stat.size / 1024).toFixed(1)} KB)`
  );
}

buildSingleFile().catch((err) => {
  console.error(err);
  process.exit(1);
});
