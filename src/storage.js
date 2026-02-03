import fs from "node:fs";
import path from "node:path";

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
const VERIFIED_PATH = path.join(STORAGE_DIR, "verified.json");

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(VERIFIED_PATH)) fs.writeFileSync(VERIFIED_PATH, JSON.stringify({ users: {} }, null, 2));
}

export function loadVerified() {
  ensureStorage();
  const raw = fs.readFileSync(VERIFIED_PATH, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return { users: {} };
  }
}

export function saveVerified(data) {
  ensureStorage();
  fs.writeFileSync(VERIFIED_PATH, JSON.stringify(data, null, 2));
}

export function upsertVerifiedUser(discordUserId, payload) {
  const db = loadVerified();
  db.users[discordUserId] = {
    ...(db.users[discordUserId] || {}),
    ...payload,
    updatedAt: new Date().toISOString()
  };
  saveVerified(db);
  return db.users[discordUserId];
}
