import sharp from "sharp";
import { createWorker } from "tesseract.js";

function parseFromText(text) {
  const t = String(text || "");

  const idMatch = t.match(/ID\s*[:#]?\s*([0-9]{6,})/i);
  const kingdomMatch = t.match(/Kingdom\s*[:#]?\s*#?\s*([0-9]{1,4})/i);
  const allianceMatch = t.match(/Alliance\s*[:#]?\s*([A-Z0-9]{2,6})/i);

  const bracketTag = t.match(/\[\s*([A-Z0-9]{2,6})\s*\]/);

  const id = idMatch ? idMatch[1] : null;
  const kingdom = kingdomMatch ? kingdomMatch[1] : null;

  // prefer [TAG] if found, else Alliance: TAG
  const clanTag = (bracketTag ? bracketTag[1] : (allianceMatch ? allianceMatch[1] : null)) || null;

  return { id, kingdom, clanTag, raw: t };
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
  // grayscale + resize up + threshold-ish via linear to help Tesseract
  let img = sharp(buffer).extract(crop).grayscale();

  // upscale ~2x to help OCR
  img = img.resize({ width: crop.width * 2 });

  // increase contrast a bit (simple linear transform)
  img = img.linear(1.6, -40);

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

  // 2) Small crop just for the name/tag line (top of the card)
  const nameCrop = cropByRatios(meta, {
    left: 0.33,
    top: 0.60,
    width: 0.64,
    height: 0.07
  });

  const nameBuf = await preprocessForOcr(buffer, nameCrop);
  const nameText = await ocrImageBuffer(nameBuf);
  const nameParsed = parseFromText(nameText);

  const merged = {
    id: cardParsed.id || nameParsed.id,
    kingdom: cardParsed.kingdom || nameParsed.kingdom,
    clanTag: (nameParsed.clanTag || cardParsed.clanTag || null)?.toUpperCase() || null,
    debug: {
      cardText: cardParsed.raw,
      nameText: nameParsed.raw
    }
  };

  if (!merged.id || !merged.kingdom || !merged.clanTag) {
    const missing = ["id", "kingdom", "clanTag"].filter((k) => !merged[k]);
    throw new Error(`Could not read: ${missing.join(", ")}. (Image may be cropped/wrong screen/low quality.)`);
  }

  return merged;
}
