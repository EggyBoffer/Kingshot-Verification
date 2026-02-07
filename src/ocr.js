import sharp from "sharp";
import { createWorker } from "tesseract.js";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cleanClanTag(s) {
  return String(s || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 6);
}

function cleanPlayerName(s) {
  return String(s || "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 24);
}

function parseFromText(text) {
  const raw = String(text || "");
  const t = raw.replace(/\r/g, "");

  const idMatch = t.match(/ID\s*[:#]?\s*([0-9]{6,})/i);
  const kingdomMatch = t.match(/Kingdom\s*[:#]?\s*#?\s*([0-9]{1,4})/i);
  const allianceMatch = t.match(/Alliance\s*[:#]?\s*([A-Z0-9]{2,6})/i);

  const tagAndName = t.match(/\[\s*([A-Z0-9]{2,6})\s*\]\s*([A-Z0-9_]{2,24})/i);

  let clanTag = tagAndName ? tagAndName[1] : (allianceMatch ? allianceMatch[1] : null);
  let playerName = tagAndName ? tagAndName[2] : null;

  if (!playerName) {
    const tagOnly = t.match(/\[\s*([A-Z0-9]{2,6})\s*\]/);
    if (tagOnly) {
      clanTag = clanTag || tagOnly[1];

      const idx = t.indexOf(tagOnly[0]);
      if (idx !== -1) {
        const after = t.slice(idx + tagOnly[0].length);

        const candidate = after
          .split("\n")[0]
          .trim()
          .split(/\s{2,}/)[0]
          .split("ID:")[0]
          .split("ID")[0]
          .trim();

        const cleaned = cleanPlayerName(candidate);

        if (cleaned.length >= 3) {
          playerName = cleaned;
        }
      }
    }
  }

  return {
    id: idMatch ? idMatch[1] : null,
    kingdom: kingdomMatch ? kingdomMatch[1] : null,
    clanTag: clanTag || null,
    playerName: playerName || null,
    raw: t
  };
}

function cropByRatios(meta, ratios) {
  const w = meta.width;
  const h = meta.height;

  const left = Math.max(0, Math.floor(w * ratios.left));
  const top = Math.max(0, Math.floor(h * ratios.top));
  const width = Math.min(w - left, Math.floor(w * ratios.width));
  const height = Math.min(h - top, Math.floor(h * ratios.height));

  return { left, top, width, height };
}

// Filter noisy tesseract output while keeping progress if you ever want it
function quietLogger(m) {
  const msg = String(m?.message || "");

  if (
    msg.includes("Image too small to scale") ||
    msg.includes("Line cannot be recognized") ||
    msg.includes("OSD") ||
    msg.includes("Estimating resolution")
  ) {
    return;
  }
}

async function ocrWithOptions(buffer, options = {}) {
  const worker = await createWorker("eng", 1, {
    logger: quietLogger
  });

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: options.psm ?? "6",
      tessedit_char_whitelist: options.whitelist ?? "",
      preserve_interword_spaces: "1"
    });

    const { data } = await worker.recognize(buffer);
    return data.text || "";
  } finally {
    await worker.terminate();
  }
}

/**
 * Normalize screenshots across phones:
 * - some devices create massive images that cause sharp/tesseract to fail or OOM
 * - we downscale large ones and lightly upscale tiny ones
 */
async function normalizeInput(buffer) {
  const img = sharp(buffer, {
    limitInputPixels: false,
    failOnError: false
  });

  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("Invalid image (missing dimensions).");

  const w = meta.width;
  const h = meta.height;
  const pixels = w * h;

  // Safety rails:
  // - cap pixel count and max width so we don't blow up RAM on Railway
  const MAX_WIDTH = 2200;
  const MAX_PIXELS = 10_000_000; // ~10MP is plenty for OCR after preprocessing
  const MIN_WIDTH = 900; // helps tiny crops

  let out = img;

  // Downscale if too big (either dimension or total pixels)
  if (w > MAX_WIDTH || pixels > MAX_PIXELS) {
    out = out.resize({
      width: MAX_WIDTH,
      fit: "inside",
      withoutEnlargement: true
    });
  } else if (w < MIN_WIDTH) {
    // Light upscale for small images (don’t go crazy)
    out = out.resize({
      width: MIN_WIDTH,
      fit: "inside",
      withoutEnlargement: false
    });
  }

  // Convert to PNG to standardize weird formats/metadata
  const normalizedBuffer = await out.png().toBuffer();
  const normalizedMeta = await sharp(normalizedBuffer, {
    limitInputPixels: false,
    failOnError: false
  }).metadata();

  return { buffer: normalizedBuffer, meta: normalizedMeta };
}

async function preprocessForCard(buffer, crop) {
  // Crop first, then upscale to a sane width (don’t balloon huge screenshots)
  let img = sharp(buffer, { limitInputPixels: false, failOnError: false })
    .extract(crop)
    .grayscale();

  const targetW = clamp(Math.floor(crop.width * 2), 700, 1600);
  img = img.resize({ width: targetW, fit: "inside" });

  img = img.linear(1.6, -40).sharpen();
  return await img.png().toBuffer();
}

async function preprocessForNameHunt(buffer, meta) {
  let img = sharp(buffer, { limitInputPixels: false, failOnError: false }).grayscale();

  const baseW = meta?.width || 0;

  // previously: width * 1.5 (can explode on modern phones)
  // now: clamp it
  const targetW = clamp(Math.floor(baseW * 1.25), 900, 2000);
  img = img.resize({ width: targetW, fit: "inside", withoutEnlargement: false });

  img = img.linear(2.2, -70).threshold(175).sharpen();

  return await img.png().toBuffer();
}

export async function extractKingshotProfile(buffer) {
  // Normalize input first so all phone screenshots behave similarly
  const normalized = await normalizeInput(buffer);
  const normBuf = normalized.buffer;
  const meta = normalized.meta;

  if (!meta.width || !meta.height) throw new Error("Invalid image (missing dimensions).");

  const cardCrop = cropByRatios(meta, {
    left: 0.02,
    top: 0.56,
    width: 0.96,
    height: 0.40
  });

  const cardBuf = await preprocessForCard(normBuf, cardCrop);
  const cardText = await ocrWithOptions(cardBuf, { psm: "6" });
  const cardParsed = parseFromText(cardText);

  const huntBuf = await preprocessForNameHunt(normBuf, meta);
  const huntText = await ocrWithOptions(huntBuf, {
    psm: "6",
    whitelist: "[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_ "
  });
  const huntParsed = parseFromText(huntText);

  const clanTag = cleanClanTag(huntParsed.clanTag || cardParsed.clanTag);
  const playerName = cleanPlayerName(huntParsed.playerName || cardParsed.playerName);

  const merged = {
    id: cardParsed.id || null,
    kingdom: cardParsed.kingdom || null,
    clanTag: clanTag || null,
    playerName: playerName || null,
    debug: { cardText, huntText }
  };

  if (!merged.id || !merged.kingdom || !merged.clanTag) {
    const missing = ["id", "kingdom", "clanTag"].filter((k) => !merged[k]);
    throw new Error(`Could not read: ${missing.join(", ")}. (Image may be cropped/wrong screen/low quality.)`);
  }

  return merged;
}