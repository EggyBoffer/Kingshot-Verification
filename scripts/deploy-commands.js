import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify your Kingshot profile via screenshot"),

  new SlashCommandBuilder()
    .setName("verify_manual")
    .setDescription("Admin-only manual verification (grant selected roles)")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("The user to verify").setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt.setName("give_verified").setDescription("Give Verified role").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName("give_clan_role").setDescription("Give clan role (requires clan)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName("give_kingdom_role").setDescription("Give kingdom role (requires kingdom)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName("set_nickname").setDescription("Set nickname (requires clan + name)").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("name").setDescription("In-game name (optional)").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("clan").setDescription("Clan tag (optional)").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("id").setDescription("Kingshot ID (optional)").setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName("kingdom").setDescription("Kingdom number (optional)").setRequired(false)
    )
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("🔧 Deploying guild slash commands…");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("✅ Done.");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
