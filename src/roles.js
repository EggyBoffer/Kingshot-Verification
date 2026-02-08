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

  // Clan roles (tag -> role id)
  clanRoleMap: {
    SOB: process.env.ROLE_CLAN_SOB_ID || null,

    // Added: THE clan
    THE: "1470047600114925732"
  },

  // Kingdom roles (kingdom number -> role id)
  kingdomRoleMap: {
    "247": process.env.ROLE_KINGDOM_247_ID || null
  }
};

export function rolesFor(clanTag, kingdom) {
  const roleIds = [];

  const clanKey = String(clanTag || "").toUpperCase().trim();
  const clanRole = CONFIG.clanRoleMap[clanKey];
  if (clanRole) roleIds.push(clanRole);

  const kingdomKey = String(kingdom || "").replace(/^#/, "").trim();
  const kRole = CONFIG.kingdomRoleMap[kingdomKey];
  if (kRole) roleIds.push(kRole);

  return roleIds;
}