/**
 * Stage a folder of beer photos into pending-photos/ for the existing
 * "Upload Pending Photos to Shopify" GitHub Action to pick up.
 *
 * Matches each photo to a product by exact title or beer-name portion,
 * using the committed public/products.json (no Shopify token needed —
 * that file is refreshed hourly by sync.js). Resizes to a sane web size
 * via macOS `sips` and renames to the exact product title so the Action's
 * own matching succeeds.
 *
 * Files that don't match anything are left in place and listed at the
 * end — typos, translations, or non-standard names need a quick manual
 * look (rename to match, or add to OVERRIDES below) before re-running.
 *
 * Usage: node stage-photos.js /path/to/photos/folder
 * Then:  git add pending-photos/ && git commit -m "..." && git push
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = process.argv[2];
const pendingDir = path.join(__dirname, "pending-photos");

if (!photosDir || !fs.existsSync(photosDir)) {
  console.error("Usage: node stage-photos.js /path/to/photos/folder");
  process.exit(1);
}

const products = JSON.parse(fs.readFileSync(path.join(__dirname, "public/products.json"), "utf8"));

// Add entries here for filenames that need a manual/visual resolution
// (typos, translations, alt names). Key = normalized filename (see normKey).
const OVERRIDES = new Map([
  // ["Some Typo'd Name", "Exact Shopify Product Title"],
].map(([k, v]) => [cleanPunct(k), v]));

function cleanPunct(s) {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/ — /g, " ").replace(/\s*\/\s*/g, " ")
    .replace(/['".!]/g, "").replace(/[\/(),_-]/g, " ")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

const stripPrefix = (name) => name.replace(/^BH\s*-?\s*/i, "").trim();

function normKey(file) {
  const nameWithoutExt = path.basename(file, path.extname(file)).replace(/\(\d+\)\s*$/, "").trim();
  return cleanPunct(stripPrefix(nameWithoutExt));
}

const byTitle = new Map();
const byFullTitle = new Map();
const byBeerName = new Map();
for (const p of products) {
  byTitle.set(p.title.trim(), p);
  byFullTitle.set(cleanPunct(p.title), p);
  const dashIdx = p.title.indexOf(" — ");
  if (dashIdx !== -1) {
    const beer = cleanPunct(p.title.slice(dashIdx + 3));
    if (!byBeerName.has(beer)) byBeerName.set(beer, []);
    byBeerName.get(beer).push(p);
  }
}

fs.mkdirSync(pendingDir, { recursive: true });

const imageFiles = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
const staged = [];
const noMatch = [];

for (const file of imageFiles) {
  let product = null;

  const overrideTitle = OVERRIDES.get(normKey(file));
  if (overrideTitle) product = byTitle.get(overrideTitle);

  if (!product) {
    const nameWithoutExt = path.basename(file, path.extname(file)).replace(/\(\d+\)\s*$/, "").trim();
    const stripped = stripPrefix(nameWithoutExt);
    product = byFullTitle.get(cleanPunct(stripped));
    if (!product) {
      const parts = stripped.split(/\s*-\s*/).map(p => p.trim()).filter(Boolean);
      const beerGuess = cleanPunct(parts[parts.length - 1]);
      const candidates = byBeerName.get(beerGuess);
      if (candidates?.length === 1) product = candidates[0];
    }
  }

  if (!product) {
    noMatch.push(file);
    continue;
  }

  const destName = product.title.replace(/\s*\/\s*/g, " - ") + path.extname(file).toLowerCase();
  const destPath = path.join(pendingDir, destName);
  execFileSync("sips", ["-Z", "2000", "-s", "formatOptions", "80", path.join(photosDir, file), "--out", destPath], { stdio: "ignore" });
  staged.push({ file, title: product.title });
}

console.log(`Staged ${staged.length} photo(s) into pending-photos/:`);
for (const s of staged) console.log(`  ${s.file} → ${s.title}`);

if (noMatch.length) {
  console.log(`\nNo match for ${noMatch.length} file(s) — rename to match a product title, or add to OVERRIDES, then re-run:`);
  for (const f of noMatch) console.log(`  ${f}`);
}
