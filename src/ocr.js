import sharp from "sharp";
import { createWorker } from "tesseract.js";

const STOP_NAMES = new Set([
  "as",
  "an",
  "id",
  "kingdom",
  "alliance",
  "kills",
  "mood"
]);

function parseFromText(text) {
  const t = String(text || "");

  const idMatch = t.match(/ID\s*[:#]?\s*([0-9]{6,})/i);
  const kingdomMatch = t.match(/Kingdom\s*[:#]?\s*#?\s*([0-9]{1,4})/i);
  const allianceMatch = t.match(/Alliance\s*[:#]?\s*([A-Z0-9]{2,6})/i);

  // Matches "[SOB]Gashers95" or "[SOB] Gashers95"
  const tagAndName = t.match(/\[\s*([A-Z0-9]{2,6})\s*\]\s*([A-Z0-9_]{2,24})/i);

  const id = idMatch ? idMatch[1] : null;
  const kingdom = kingdomMatch ? kingdomMatch[1] : null;
  const clanTag = (tagAndName ? tagAndName[1] : (allianceMatch ? allianceMatch[1] : null)) || null;
  const playerName = (tagAndName ? tagAndName[2] : null) || null;

  return { id, kingdom, clanTag, playerName, raw: t };
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

function isPlausibleName(name) {
  const n = cleanPlayerName(name);
  if (!n || n.length < 3) return false;
  if (STOP_NAMES.has(n.toLowerCase())) return false;
  // Must start with a letter/number and not be ALL punctuation (already cleaned)
  return true;
}

function pickBestName(names) {
  const cleaned = names
    .map(cleanPlayerName)
    .filter((n) => isPlausibleName(n));

  if (!cleaned.length) return null;

  // Prefer longer names; tie-breaker: names with digits (often common in-game)
  cleaned.sort((a, b) => {
    const score = (x) => x.length + (/\d/.test(x) ? 2 : 0);
    return score(b) - score(a);
  });

  return cleaned[0];
}

async function ocrImageBuffer(buffer) {
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(buffer);
    return data.text || "";
  } finally {
    await worker.terminate();
  }
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

async function preprocessForCard(buffer, crop) {
  // For ID/Kingdom/etc.
  let img = sharp(buffer).extract(crop).grayscale();
  img = img.resize({ width: Math.max(400, crop.width * 2) });
  img = img.linear(1.6, -40).sharpen();
  return await img.png().toBuffer();
}

async function preprocessForName(buffer, crop) {
  // For white name text on blue background: threshold helps massively
  let img = sharp(buffer).extract(crop).grayscale();

  // Upscale
  img = img.resize({ width: Math.max(500, crop.width * 3) });

  // Boost contrast and binarize
  img = img.linear(2.0, -60);
  img = img.threshold(170);

  // Light sharpen after threshold
  img = img.sharpen();

  return await img.png().toBuffer();
}

export async function extractKingshotProfile(buffer) {
  const base = sharp(buffer);
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error("Invalid image (missing dimensions).");

  // Big crop: bottom card for ID/Alliance/Kingdom
  const cardCrop = cropByRatios(meta, {
    left: 0.02,
    top: 0.56,
    width: 0.96,
    height: 0.40
  });

  const cardBuf = await preprocessForCard(buffer, cardCrop);
  const cardText = await ocrImageBuffer(cardBuf);
  const cardParsed = parseFromText(cardText);

  // Name line crop attempts:
  // Wide: catches name even if UI shifts a bit
  const nameCropWide = cropByRatios(meta, {
    left: 0.30,
    top: 0.60,
    width: 0.66,
    height: 0.10
  });

  // Tight: focuses only on the [TAG]Name text area, avoids icons
  const nameCropTight = cropByRatios(meta, {
    left: 0.42,
    top: 0.62,
    width: 0.54,
    height: 0.06
  });

  const nameBufWide = await preprocessForName(buffer, nameCropWide);
  const nameTextWide = await ocrImageBuffer(nameBufWide);
  const nameParsedWide = parseFromText(nameTextWide);

  const nameBufTight = await preprocessForName(buffer, nameCropTight);
  const nameTextTight = await ocrImageBuffer(nameBufTight);
  const nameParsedTight = parseFromText(nameTextTight);

  const clanTag = cleanClanTag(nameParsedTight.clanTag || nameParsedWide.clanTag || cardParsed.clanTag);

  // Collect possible names from multiple reads + fallback to scanning raw text
  const nameCandidates = [
    nameParsedTight.playerName,
    nameParsedWide.playerName,
    cardParsed.playerName
  ].filter(Boolean);

  const playerName = pickBestName(nameCandidates);

  const merged = {
    id: cardParsed.id || null,
    kingdom: cardParsed.kingdom || null,
    clanTag: clanTag || null,
    playerName: playerName || null,
    debug: {
      cardText,
      nameTextWide,
      nameTextTight
    }
  };

  if (!merged.id || !merged.kingdom || !merged.clanTag) {
    const missing = ["id", "kingdom", "clanTag"].filter((k) => !merged[k]);
    throw new Error(`Could not read: ${missing.join(", ")}. (Image may be cropped/wrong screen/low quality.)`);
  }

  return merged;
}
