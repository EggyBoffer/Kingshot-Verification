function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const CONFIG = {
  guildId: mustEnv("GUILD_ID"),
  verifyChannelId: mustEnv("VERIFY_CHANNEL_ID"),

  roleUnverifiedId: mustEnv("ROLE_UNVERIFIED_ID"),
  roleVerifiedId: mustEnv("ROLE_VERIFIED_ID"),

  clanRoleMap: {
    SOB: process.env.ROLE_CLAN_SOB_ID || null
  },

  kingdomRoleMap: {
    "247": process.env.ROLE_KINGDOM_247_ID || null
  }
};

export function rolesFor(clanTag, kingdom) {
  const roleIds = [];

  const clanRole = CONFIG.clanRoleMap[String(clanTag || "").toUpperCase()];
  if (clanRole) roleIds.push(clanRole);

  const kRole = CONFIG.kingdomRoleMap[String(kingdom || "").replace(/^#/, "").trim()];
  if (kRole) roleIds.push(kRole);

  return roleIds;
}
