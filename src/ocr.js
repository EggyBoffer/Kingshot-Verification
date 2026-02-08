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

  // English: "Kingdom: #247"
  // Polish:  "Królestwo: #247"
  const kingdomMatch =
    t.match(/Kingdom\s*[:#]?\s*#?\s*([0-9]{1,4})/i) ||
    t.match(/Kr[oó]lestwo\s*[:#]?\s*#?\s*([0-9]{1,4})/i);

  // English: "Alliance: SOB"
  // Polish:  "Sojusz: SOB"
  const allianceMatch =
    t.match(/Alliance\s*[:#]?\s*([A-Z0-9]{2,6})/i) ||
    t.match(/Sojusz\s*[:#]?\s*([A-Z0-9]{2,6})/i);

  const tagAndName = t.match(/\[\s*([A-Z0-9]{2,6})\s*\]\s*([A-Z0-9_]{2,24})/i);

  let clanTag = tagAndName ? tagAndName[1] : allianceMatch ? allianceMatch[1] : null;
  let playerName = tagAndName ? tagAndName[2] : null;

  // Fallback: find [TAG] and try to read name directly after it on same line
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
        if (cleaned.length >= 3) playerName = cleaned;
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

// Quiet noisy tesseract messages that don't impact results
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
  const worker = await createWorker("eng", 1, { logger: quietLogger });

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
 * - Downscale massive images to avoid memory spikes
 * - Lightly upscale tiny images so text is legible
 * - Convert to PNG to standardize format
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

  const MAX_WIDTH = 2200;
  const MAX_PIXELS = 10_000_000; // ~10MP
  const MIN_WIDTH = 900;

  let out = img;

  if (w > MAX_WIDTH || pixels > MAX_PIXELS) {
    out = out.resize({
      width: MAX_WIDTH,
      fit: "inside",
      withoutEnlargement: true
    });
  } else if (w < MIN_WIDTH) {
    out = out.resize({
      width: MIN_WIDTH,
      fit: "inside",
      withoutEnlargement: false
    });
  }

  const normalizedBuffer = await out.png().toBuffer();
  const normalizedMeta = await sharp(normalizedBuffer, {
    limitInputPixels: false,
    failOnError: false
  }).metadata();

  return { buffer: normalizedBuffer, meta: normalizedMeta };
}

async function preprocessForPanel(buffer, cropOrNull) {
  // If cropOrNull is provided, extract it; otherwise treat the whole image as the panel.
  let img = sharp(buffer, { limitInputPixels: false, failOnError: false }).grayscale();

  if (cropOrNull) img = img.extract(cropOrNull);

  const meta = await img.metadata();
  const w = meta.width || 0;

  // Panel OCR wants readable text, but not insane sizes
  const targetW = clamp(Math.floor(w * 2), 700, 1600);
  img = img.resize({ width: targetW, fit: "inside" });

  img = img.linear(1.6, -40).sharpen();

  return await img.png().toBuffer();
}

async function preprocessForNameHunt(buffer, meta) {
  let img = sharp(buffer, { limitInputPixels: false, failOnError: false }).grayscale();

  const baseW = meta?.width || 0;

  // Clamp to avoid ballooning large screenshots
  const targetW = clamp(Math.floor(baseW * 1.25), 900, 2000);
  img = img.resize({ width: targetW, fit: "inside", withoutEnlargement: false });

  img = img.linear(2.2, -70).threshold(175).sharpen();

  return await img.png().toBuffer();
}

export async function extractKingshotProfile(buffer) {
  const normalized = await normalizeInput(buffer);
  const normBuf = normalized.buffer;
  const meta = normalized.meta;

  if (!meta.width || !meta.height) throw new Error("Invalid image (missing dimensions).");

  // 1) First pass: support images that are ALREADY cropped to the bottom panel
  // (like the example you posted)
  const directPanelBuf = await preprocessForPanel(normBuf, null);
  const directPanelText = await ocrWithOptions(directPanelBuf, { psm: "6" });
  const directPanelParsed = parseFromText(directPanelText);

  // If we got the essentials, we can accept immediately without any ratio cropping
  const directHasCore = !!(directPanelParsed.id && directPanelParsed.kingdom && directPanelParsed.clanTag);

  // 2) Fallback: multi-crop (handles full screenshots with varying UI layouts/languages)
  const cardCrops = [
    // Default (roomier UI)
    { left: 0.02, top: 0.56, width: 0.96, height: 0.40 },
    // Compact UI (often non-English / smaller bottom panel)
    { left: 0.02, top: 0.48, width: 0.96, height: 0.44 }
  ];

  let cardParsed = { id: null, kingdom: null, clanTag: null, playerName: null, raw: "" };
  let cardTextBest = directPanelText || "";

  if (!directHasCore) {
    for (const ratios of cardCrops) {
      const crop = cropByRatios(meta, ratios);
      const buf = await preprocessForPanel(normBuf, crop);
      const text = await ocrWithOptions(buf, { psm: "6" });
      const parsed = parseFromText(text);

      if (!cardTextBest) cardTextBest = text;

      if (parsed.id && parsed.kingdom) {
        cardParsed = parsed;
        cardTextBest = text;
        break;
      }

      if (!cardParsed.id) cardParsed.id = parsed.id;
      if (!cardParsed.kingdom) cardParsed.kingdom = parsed.kingdom;
      if (!cardParsed.clanTag) cardParsed.clanTag = parsed.clanTag;
      if (!cardParsed.playerName) cardParsed.playerName = parsed.playerName;
      if (!cardParsed.raw) cardParsed.raw = parsed.raw;

      if ((parsed.id || parsed.kingdom || parsed.clanTag) && text) {
        cardTextBest = text;
      }
    }
  } else {
    cardParsed = directPanelParsed;
    cardTextBest = directPanelText;
  }

  // Name hunt pass:
  // For cropped panel images, this is still fine (it's just OCR over the image again),
  // and it helps pull [TAG]Name if the panel pass missed the name.
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
    debug: {
      cardText: cardTextBest || cardParsed.raw || "",
      huntText
    }
  };

  if (!merged.id || !merged.kingdom || !merged.clanTag) {
    const missing = ["id", "kingdom", "clanTag"].filter((k) => !merged[k]);
    throw new Error(
      `Could not read: ${missing.join(", ")}. (Image may be cropped/wrong screen/low quality.)`
    );
  }

  return merged;
}