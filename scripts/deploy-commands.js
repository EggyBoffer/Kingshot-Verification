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
    .setDescription("Admin-only manual verification (name/clan/id/kingdom)")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("The user to verify")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("In-game name from the screenshot (e.g. BeachBoffer)")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("clan")
        .setDescription("Clan tag from the screenshot (e.g. SOB)")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("id")
        .setDescription("Kingshot ID from the screenshot (digits only)")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("kingdom")
        .setDescription("Kingdom number (e.g. 247)")
        .setRequired(false)
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
