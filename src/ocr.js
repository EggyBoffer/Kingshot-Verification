import sharp from "sharp";
import { createWorker } from "tesseract.js";

function parseFromText(text) {
  const t = String(text || "");

  const idMatch = t.match(/ID\s*[:#]?\s*([0-9]{6,})/i);
  const kingdomMatch = t.match(/Kingdom\s*[:#]?\s*#?\s*([0-9]{1,4})/i);
  const allianceMatch = t.match(/Alliance\s*[:#]?\s*([A-Z0-9]{2,6})/i);

  // Matches "[SOB]BeachBoffer" or "[SOB] BeachBoffer"
  const tagAndName = t.match(/\[\s*([A-Z0-9]{2,6})\s*\]\s*([A-Z0-9_]{2,20})/i);

  // Sometimes OCR drops brackets, so try "SOB BeachBoffer"
  const tagSpaceName = t.match(/\b([A-Z0-9]{2,6})\b\s+([A-Z0-9_]{2,20})/i);

  const id = idMatch ? idMatch[1] : null;
  const kingdom = kingdomMatch ? kingdomMatch[1] : null;

  // Prefer bracket tag if found
  const clanTag =
    (tagAndName ? tagAndName[1] : null) ||
    (allianceMatch ? allianceMatch[1] : null) ||
    null;

  // Prefer name paired with tag
  const playerName =
    (tagAndName ? tagAndName[2] : null) ||
    (tagSpaceName ? tagSpaceName[2] : null) ||
    null;

  return { id, kingdom, clanTag, playerName, raw: t };
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

async function preprocessForOcr(buffer, crop) {
  let img = sharp(buffer).extract(crop).grayscale();

  // upscale helps OCR a lot
  img = img.resize({ width: crop.width * 2 });

  // boost contrast
  img = img.linear(1.7, -45);

  // sharpen edges
  img = img.sharpen();

  return await img.png().toBuffer();
}

export async function extractKingshotProfile(buffer) {
  const base = sharp(buffer);
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error("Invalid image (missing dimensions).");

  // 1) Big crop around the profile card area (bottom-ish)
  const cardCrop = cropByRatios(meta, {
    left: 0.02,
    top: 0.56,
    width: 0.96,
    height: 0.40
  });

  const cardBuf = await preprocessForOcr(buffer, cardCrop);
  const cardText = await ocrImageBuffer(cardBuf);
  const cardParsed = parseFromText(cardText);

  // 2) Crop for the top line of the card (tag + name)
  const nameCrop = cropByRatios(meta, {
    left: 0.24,
    top: 0.58,
    width: 0.74,
    height: 0.10
  });

  const nameBuf = await preprocessForOcr(buffer, nameCrop);
  const nameText = await ocrImageBuffer(nameBuf);
  const nameParsed = parseFromText(nameText);

  const clanTag = (nameParsed.clanTag || cardParsed.clanTag || null)?.toUpperCase() || null;

  // Clean name (OCR sometimes adds junk)
  const playerNameRaw = nameParsed.playerName || cardParsed.playerName || null;
  const playerName = playerNameRaw
    ? String(playerNameRaw).replace(/[^A-Za-z0-9_]/g, "").slice(0, 24)
    : null;

  const merged = {
    id: cardParsed.id || nameParsed.id,
    kingdom: cardParsed.kingdom || nameParsed.kingdom,
    clanTag,
    playerName,
    debug: {
      cardText: cardParsed.raw,
      nameText: nameParsed.raw
    }
  };

  if (!merged.id || !merged.kingdom || !merged.clanTag) {
    const missing = ["id", "kingdom", "clanTag"].filter((k) => !merged[k]);
    throw new Error(`Could not read: ${missing.join(", ")}. (Image may be cropped/wrong screen/low quality.)`);
  }

  // Name is nice-to-have, not required
  return merged;
}
