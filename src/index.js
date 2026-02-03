import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits
} from "discord.js";

import { CONFIG, rolesFor } from "./roles.js";
import { extractKingshotProfile } from "./ocr.js";
import { upsertVerifiedUser } from "./storage.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

function buildNickname(clanTag, playerName) {
  const tag = String(clanTag || "").toUpperCase().trim();
  const name = String(playerName || "").trim();

  if (!tag && !name) return null;
  if (!name) return `[${tag}]`;
  if (!tag) return name;

  return `[${tag}] ${name}`;
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

function cleanId(s) {
  const digits = String(s || "").replace(/\D/g, "");
  return digits.length >= 6 ? digits : null;
}

function cleanKingdom(s) {
  const digits = String(s || "").replace(/\D/g, "");
  return digits.length >= 1 ? digits.slice(0, 4) : null;
}

async function applyVerification({ guild, userId, clanTag, playerName, gameId, kingdom }) {
  const member = await guild.members.fetch(userId);

  const roleIds = rolesFor(clanTag, kingdom);
  const toAdd = [CONFIG.roleVerifiedId, ...roleIds].filter(Boolean);
  const toRemove = [CONFIG.roleUnverifiedId].filter(Boolean);

  if (toAdd.length) await member.roles.add(toAdd);
  if (toRemove.length) await member.roles.remove(toRemove);

  const desiredNick = buildNickname(clanTag, playerName);
  if (desiredNick) {
    await member.setNickname(desiredNick, "Kingshot verification nickname sync");
  }

  upsertVerifiedUser(userId, {
    gameId,
    clanTag,
    kingdom: kingdom || null,
    playerName: playerName || null
  });

  return { member, desiredNick, roleIds };
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ---------- /verify (OCR path) ----------
  if (interaction.commandName === "verify") {
    try {
      if (interaction.guildId !== CONFIG.guildId) {
        return interaction.reply({ content: "❌ Wrong server.", ephemeral: true });
      }

      if (interaction.channelId !== CONFIG.verifyChannelId) {
        return interaction.reply({
          content: "❌ Use /verify in the verification channel.",
          ephemeral: true
        });
      }

      await interaction.reply({
        content: "✅ Creating your private verification thread…",
        ephemeral: true
      });

      const channel = await interaction.channel.fetch();
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.followUp({
          content: "❌ Verification channel must be a normal text channel.",
          ephemeral: true
        });
      }

      const thread = await channel.threads.create({
        name: `verify-${interaction.user.username}`.slice(0, 100),
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        invitable: false
      });

      await thread.members.add(interaction.user.id);

      await thread.send(
        [
          `Alright <@${interaction.user.id}>, drop **one screenshot** of your Kingshot **Governor Profile** screen (like the example).`,
          `I’m looking for: **[ClanTag]Name**, **ID**, and **Kingdom**.`,
          ``,
          `Tips so the bot doesn’t have a meltdown:`,
          `• Don’t crop the bottom info panel`,
          `• Keep it clear (no motion blur)`,
          `• One image only`
        ].join("\n")
      );

      const collected = await thread.awaitMessages({
        filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0,
        max: 1,
        time: 3 * 60 * 1000
      });

      if (!collected.size) {
        await thread.send("⏳ Timed out. Run /verify again when you’re ready.");
        await thread.setArchived(true);
        return;
      }

      const msg = collected.first();
      const attachment = msg.attachments.first();
      if (!attachment) {
        await thread.send("❌ No attachment found. Try again.");
        return;
      }

      await thread.send("🔎 Reading screenshot… (if this takes more than a moment, it’s Tesseract being dramatic)");

      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      const parsed = await extractKingshotProfile(buffer);

      const clanTag = cleanClanTag(parsed.clanTag);
      const playerName = cleanPlayerName(parsed.playerName || "");
      const gameId = cleanId(parsed.id);
      const kingdom = cleanKingdom(parsed.kingdom);

      if (!clanTag || !gameId) {
        throw new Error("OCR read failed (missing clan tag or ID). Ask an admin to use /verify_manual.");
      }

      await applyVerification({
        guild: interaction.guild,
        userId: interaction.user.id,
        clanTag,
        playerName: playerName || interaction.user.username,
        gameId,
        kingdom
      });

      await thread.send(
        [
          `✅ Verified!`,
          `• Clan: **${clanTag}**`,
          `• Name: **${playerName || "Unknown"}**`,
          `• ID: **${gameId}**`,
          `• Kingdom: **${kingdom ? `#${kingdom}` : "Unknown"}**`,
          ``,
          `Roles assigned. Your ID has been stored.`
        ].join("\n")
      );

      await thread.setArchived(true);
    } catch (err) {
      console.error(err);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: `❌ Verification failed: ${err.message}`, ephemeral: true });
        } else {
          await interaction.reply({ content: `❌ Verification failed: ${err.message}`, ephemeral: true });
        }
      } catch {}
    }
    return;
  }

  // ---------- /verify_manual (Admin-only) ----------
  if (interaction.commandName === "verify_manual") {
    try {
      if (interaction.guildId !== CONFIG.guildId) {
        return interaction.reply({ content: "❌ Wrong server.", ephemeral: true });
      }

      // Admin only
      const invoker = await interaction.guild.members.fetch(interaction.user.id);
      const isAdmin = invoker.permissions.has(PermissionFlagsBits.Administrator);
      if (!isAdmin) {
        return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
      }

      const targetUser = interaction.options.getUser("user", true);
      const nameInput = interaction.options.getString("name", true);
      const clanInput = interaction.options.getString("clan", true);
      const idInput = interaction.options.getString("id", true);
      const kingdomInput = interaction.options.getString("kingdom", false);

      const clanTag = cleanClanTag(clanInput);
      const playerName = cleanPlayerName(nameInput);
      const gameId = cleanId(idInput);
      const kingdom = kingdomInput ? cleanKingdom(kingdomInput) : null;

      if (!clanTag) return interaction.reply({ content: "❌ Invalid clan tag.", ephemeral: true });
      if (!playerName) return interaction.reply({ content: "❌ Invalid name.", ephemeral: true });
      if (!gameId) return interaction.reply({ content: "❌ Invalid ID (digits only, 6+ length).", ephemeral: true });

      // Optional: require kingdom if you want kingdom roles always correct
      // if (!kingdom) return interaction.reply({ content: "❌ Kingdom is required for manual verification.", ephemeral: true });

      await interaction.reply({
        content: `🛂 Manual verification in progress for <@${targetUser.id}>…`,
        ephemeral: true
      });

      const result = await applyVerification({
        guild: interaction.guild,
        userId: targetUser.id,
        clanTag,
        playerName,
        gameId,
        kingdom
      });

      const nickLine = result.desiredNick ? `Nickname set to **${result.desiredNick}**` : "Nickname not changed.";

      // If run inside the private thread, post a visible confirmation there too
      try {
        if (interaction.channel && interaction.channel.isThread && interaction.channel.isThread()) {
          await interaction.channel.send(
            [
              `✅ **Manual verification complete** for <@${targetUser.id}>`,
              `• Clan: **${clanTag}**`,
              `• Name: **${playerName}**`,
              `• ID: **${gameId}**`,
              `• Kingdom: **${kingdom ? `#${kingdom}` : "Unknown"}**`,
              `• ${nickLine}`
            ].join("\n")
          );
        }
      } catch {}

    } catch (err) {
      console.error(err);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: `❌ Manual verification failed: ${err.message}`, ephemeral: true });
        } else {
          await interaction.reply({ content: `❌ Manual verification failed: ${err.message}`, ephemeral: true });
        }
      } catch {}
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
