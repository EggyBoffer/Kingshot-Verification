import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags
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

const STOP_NAMES = new Set(["as", "an", "id", "kingdom", "alliance", "kills", "mood"]);

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

function isPlausibleName(name) {
  const n = cleanPlayerName(name);
  if (!n || n.length < 3) return false;
  if (STOP_NAMES.has(n.toLowerCase())) return false;
  return true;
}

function cleanId(s) {
  const digits = String(s || "").replace(/\D/g, "");
  return digits.length >= 6 ? digits : null;
}

function cleanKingdom(s) {
  const digits = String(s || "").replace(/\D/g, "");
  return digits.length >= 1 ? digits.slice(0, 4) : null;
}

async function applyVerification({
  guild,
  userId,
  clanTag,
  playerName,
  gameId,
  kingdom,
  giveVerified = true,
  giveClanRole = true,
  giveKingdomRole = true,
  setNickname = true
}) {
  const member = await guild.members.fetch(userId);

  const addRoles = [];
  const removeRoles = [CONFIG.roleUnverifiedId].filter(Boolean);

  if (giveVerified) addRoles.push(CONFIG.roleVerifiedId);

  if (giveClanRole || giveKingdomRole) {
    const derived = rolesFor(
      giveClanRole ? clanTag : null,
      giveKingdomRole ? kingdom : null
    );
    addRoles.push(...derived);
  }

  const toAdd = addRoles.filter(Boolean);

  if (toAdd.length) await member.roles.add(toAdd);
  if (removeRoles.length) await member.roles.remove(removeRoles);

  let desiredNick = null;
  if (setNickname) {
    const safeName = isPlausibleName(playerName) ? cleanPlayerName(playerName) : null;
    const safeTag = clanTag ? cleanClanTag(clanTag) : null;

    if (safeName && safeTag) {
      desiredNick = buildNickname(safeTag, safeName);
      await member.setNickname(desiredNick, "Kingshot verification nickname sync");
    }
  }

  upsertVerifiedUser(userId, {
    gameId: gameId || null,
    clanTag: clanTag || null,
    kingdom: kingdom || null,
    playerName: isPlausibleName(playerName) ? cleanPlayerName(playerName) : null
  });

  return { member, desiredNick };
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "verify") {
    try {
      if (interaction.guildId !== CONFIG.guildId) {
        return interaction.reply({ content: "❌ Wrong server.", flags: MessageFlags.Ephemeral });
      }

      if (interaction.channelId !== CONFIG.verifyChannelId) {
        return interaction.reply({
          content: "❌ Use /verify in the verification channel.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.reply({
        content: "✅ Creating your private verification thread… If you dont have a thread please ping @admin",
        flags: MessageFlags.Ephemeral
      });

      const channel = await interaction.channel.fetch();
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.followUp({
          content: "❌ Verification channel must be a normal text channel.",
          flags: MessageFlags.Ephemeral
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
          `Drop **one screenshot** of your Kingshot **Governor Profile** screen.`,
          `Best results if you crop to the bottom panel showing **[TAG]Name**, **ID**, **Kingdom**.`,
          ``,
          `• Don’t crop out the bottom info panel`,
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

      await thread.send("🔎 Reading screenshot…");

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

      const result = await applyVerification({
        guild: interaction.guild,
        userId: interaction.user.id,
        clanTag,
        playerName: playerName || null,
        gameId,
        kingdom,
        giveVerified: true,
        giveClanRole: true,
        giveKingdomRole: true,
        setNickname: true
      });

      await thread.send(
        [
          `✅ Verified!`,
          `• Clan: **${clanTag}**`,
          `• Name: **${playerName || "Unreadable (ask admin /verify_manual)"}**`,
          `• ID: **${gameId}**`,
          `• Kingdom: **${kingdom ? `#${kingdom}` : "Unknown"}**`,
          result.desiredNick
            ? `📝 Nickname set to **${result.desiredNick}**`
            : `📝 Nickname not changed (name unreadable).`
        ].join("\n")
      );

      await thread.setArchived(true);
    } catch (err) {
      console.error(err);
      try {
        const payload = { content: `❌ Verification failed: ${err.message}`, flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {}
    }
    return;
  }

  if (interaction.commandName === "verify_manual") {
    try {
      if (interaction.guildId !== CONFIG.guildId) {
        return interaction.reply({ content: "❌ Wrong server.", flags: MessageFlags.Ephemeral });
      }

      const invoker = await interaction.guild.members.fetch(interaction.user.id);
      const isAdmin = invoker.permissions.has(PermissionFlagsBits.Administrator);
      if (!isAdmin) {
        return interaction.reply({ content: "❌ Admin only.", flags: MessageFlags.Ephemeral });
      }

      const targetUser = interaction.options.getUser("user", true);

      const giveVerified = interaction.options.getBoolean("give_verified") ?? true;
      const giveClanRole = interaction.options.getBoolean("give_clan_role") ?? false;
      const giveKingdomRole = interaction.options.getBoolean("give_kingdom_role") ?? false;
      const setNickname = interaction.options.getBoolean("set_nickname") ?? true;

      const nameInput = interaction.options.getString("name", false);
      const clanInput = interaction.options.getString("clan", false);
      const idInput = interaction.options.getString("id", false);
      const kingdomInput = interaction.options.getString("kingdom", false);

      const clanTag = clanInput ? cleanClanTag(clanInput) : null;
      const playerName = nameInput ? cleanPlayerName(nameInput) : null;
      const gameId = idInput ? cleanId(idInput) : null;
      const kingdom = kingdomInput ? cleanKingdom(kingdomInput) : null;

      if (giveClanRole && !clanTag) {
        return interaction.reply({
          content: "❌ give_clan_role=true requires a clan tag.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (giveKingdomRole && !kingdom) {
        return interaction.reply({
          content: "❌ give_kingdom_role=true requires a kingdom number.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (setNickname && (!clanTag || !playerName || !isPlausibleName(playerName))) {
        return interaction.reply({
          content: "❌ set_nickname=true requires a valid clan + name.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.reply({
        content: `🛂 Manual verification in progress for <@${targetUser.id}>…`,
        flags: MessageFlags.Ephemeral
      });

      const result = await applyVerification({
        guild: interaction.guild,
        userId: targetUser.id,
        clanTag,
        playerName,
        gameId,
        kingdom,
        giveVerified,
        giveClanRole,
        giveKingdomRole,
        setNickname
      });

      const summary = [
        `✅ Manual verification complete for <@${targetUser.id}>`,
        giveVerified ? `• Verified role: **Yes**` : `• Verified role: **No**`,
        giveClanRole ? `• Clan role: **${clanTag}**` : `• Clan role: **No**`,
        giveKingdomRole ? `• Kingdom role: **#${kingdom}**` : `• Kingdom role: **No**`,
        gameId ? `• Stored ID: **${gameId}**` : `• Stored ID: **(not provided)**`,
        result.desiredNick ? `• Nickname: **${result.desiredNick}**` : `• Nickname: **(unchanged)**`
      ].join("\n");

      try {
        if (interaction.channel?.isThread?.()) {
          await interaction.channel.send(summary);
        }
      } catch {}
    } catch (err) {
      console.error(err);
      try {
        const payload = { content: `❌ Manual verification failed: ${err.message}`, flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {}
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
