import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const inputArg = process.argv[2] ?? 'docs/system-documentation.html';
const outputArg = process.argv[3] ?? 'docs/system-documentation.pdf';

const inputPath = path.resolve(root, inputArg);
const outputPath = path.resolve(root, outputArg);

const { browser, label, version } = await launchBrowser({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(inputPath).href, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: {
      top: '16mm',
      right: '14mm',
      bottom: '16mm',
      left: '14mm',
    },
  });
  await writeFile(outputPath, pdf);
  console.log(`Rendered ${path.relative(root, outputPath)} using ${label} ${version}`);
} finally {
  await browser.close();
}
