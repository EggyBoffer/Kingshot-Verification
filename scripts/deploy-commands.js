import { REST, Routes, SlashCommandBuilder } from "discord.js";
import "dotenv/config";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("❌ Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName("verify").setDescription("Verify your Kingshot profile via screenshot")
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
