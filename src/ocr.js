import sharp from "sharp";
import { createWorker } from "tesseract.js";

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

  // Primary: strict "[TAG]Name"
  const tagAndName = t.match(/\[\s*([A-Z0-9]{2,6})\s*\]\s*([A-Z0-9_]{2,24})/i);

  let clanTag = tagAndName ? tagAndName[1] : (allianceMatch ? allianceMatch[1] : null);
  let playerName = tagAndName ? tagAndName[2] : null;

  // Fallback: if we can spot "[TAG]" but name didn't parse, grab what follows it
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

        // Only accept if it’s not tiny junk
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

async function ocrWithOptions(buffer, options = {}) {
  const worker = await createWorker("eng");
  try {
    const params = {
      tessedit_pageseg_mode: options.psm ?? "6",
      tessedit_char_whitelist: options.whitelist ?? "",
      preserve_interword_spaces: "1"
    };

    await worker.setParameters(params);

    const { data } = await worker.recognize(buffer);
    return data.text || "";
  } finally {
    await worker.terminate();
  }
}

async function preprocessForCard(buffer, crop) {
  let img = sharp(buffer).extract(crop).grayscale();
  img = img.resize({ width: Math.max(600, crop.width * 2) });
  img = img.linear(1.6, -40).sharpen();
  return await img.png().toBuffer();
}

async function preprocessForNameHunt(buffer) {
  let img = sharp(buffer).grayscale();

  const meta = await img.metadata();
  const targetW = Math.max(900, Math.floor((meta.width || 0) * 1.5));
  img = img.resize({ width: targetW });

  img = img.linear(2.2, -70).threshold(175).sharpen();

  return await img.png().toBuffer();
}

export async function extractKingshotProfile(buffer) {
  const base = sharp(buffer);
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error("Invalid image (missing dimensions).");

  // Bottom card crop (reliable for ID/Kingdom/Alliance)
  const cardCrop = cropByRatios(meta, {
    left: 0.02,
    top: 0.56,
    width: 0.96,
    height: 0.40
  });

  const cardBuf = await preprocessForCard(buffer, cardCrop);
  const cardText = await ocrWithOptions(cardBuf, { psm: "6" });
  const cardParsed = parseFromText(cardText);

  // Whole-image “name hunt” pass
  const huntBuf = await preprocessForNameHunt(buffer);
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
      cardText,
      huntText
    }
  };

  if (!merged.id || !merged.kingdom || !merged.clanTag) {
    const missing = ["id", "kingdom", "clanTag"].filter((k) => !merged[k]);
    throw new Error(`Could not read: ${missing.join(", ")}. (Image may be cropped/wrong screen/low quality.)`);
  }

  return merged;
}
