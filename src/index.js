import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";

import { CONFIG, rolesFor } from "./roles.js";
import { extractKingshotProfile } from "./ocr.js";
import { upsertVerifiedUser } from "./storage.js";

const VERIFY_LOG_CHANNEL_ID = "1468339673289199767";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

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
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 6 ? d : null;
}

function cleanKingdom(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d ? d.slice(0, 4) : null;
}

function buildNickname(tag, name) {
  if (!tag && !name) return null;
  if (!name) return `[${tag}]`;
  if (!tag) return name;
  return `[${tag}] ${name}`;
}

function channelJump(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

async function sendVerifyLog(guild, embed) {
  try {
    const ch = await guild.channels.fetch(VERIFY_LOG_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return;
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.warn("⚠️ Failed to send verification log:", err?.message || err);
  }
}

function retryRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`verify_retry:${userId}`)
      .setLabel("Retry OCR")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`verify_cancel:${userId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function findLatestAttachmentUrlInThread(thread, userId) {
  // Pull recent messages and find latest attachment from the user
  const msgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
  if (!msgs) return null;

  for (const m of msgs.values()) {
    if (m.author?.id !== userId) continue;
    const att = m.attachments?.first?.();
    if (att?.url) return att.url;
  }
  return null;
}

async function applyVerificationFromParsed(guild, discordUserId, parsed, thread) {
  const clanTag = cleanClanTag(parsed.clanTag);
  const name = cleanPlayerName(parsed.playerName);
  const id = cleanId(parsed.id);
  const kingdom = cleanKingdom(parsed.kingdom);

  if (!clanTag || !id || !kingdom) {
    const missing = [];
    if (!clanTag) missing.push("clan");
    if (!id) missing.push("id");
    if (!kingdom) missing.push("kingdom");
    throw new Error(`OCR read failed (missing ${missing.join(", ")}).`);
  }

  const member = await guild.members.fetch(discordUserId);

  const roles = [CONFIG.roleVerifiedId, ...rolesFor(clanTag, kingdom)].filter(Boolean);

  if (roles.length) await member.roles.add(roles);
  if (CONFIG.roleUnverifiedId) await member.roles.remove(CONFIG.roleUnverifiedId);

  const nick = buildNickname(clanTag, name);
  if (nick) await member.setNickname(nick);

  upsertVerifiedUser(discordUserId, {
    gameId: id,
    clanTag,
    kingdom,
    playerName: name
  });

  await thread.send(
    [
      "✅ **Verification successful!**",
      `• Name: **${name || "Unreadable"}**`,
      `• Clan: **${clanTag}**`,
      `• ID: **${id}**`,
      `• Kingdom: **#${kingdom}**`
    ].join("\n")
  );

  await sendVerifyLog(
    guild,
    new EmbedBuilder()
      .setTitle("✅ Verification success")
      .setDescription(`User: <@${discordUserId}>`)
      .addFields(
        { name: "Name", value: name || "Unreadable", inline: true },
        { name: "Clan", value: clanTag, inline: true },
        { name: "Kingdom", value: `#${kingdom}`, inline: true },
        { name: "Game ID", value: id, inline: true },
        { name: "Thread", value: channelJump(guild.id, thread.id) }
      )
      .setTimestamp()
  );

  await thread.setArchived(true);
}

async function runOcrAttempt(guild, thread, userId, imageUrl, isRetry) {
  await thread.send(isRetry ? "🔁 Retrying OCR…" : "🔎 Reading screenshot…");

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error("Failed to download image.");
  const buf = Buffer.from(await res.arrayBuffer());

  const parsed = await extractKingshotProfile(buf);
  await applyVerificationFromParsed(guild, userId, parsed, thread);
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  // ======================
  // Buttons (Retry/Cancel)
  // ======================
  if (interaction.isButton()) {
    const [action, targetUserId] = String(interaction.customId || "").split(":");

    // Lock buttons to the user who is being verified
    if (!targetUserId || interaction.user.id !== targetUserId) {
      return interaction.reply({
        content: "❌ This button isn’t for you.",
        flags: MessageFlags.Ephemeral
      });
    }

    const thread = interaction.channel;
    if (!thread || thread.type !== ChannelType.PrivateThread) {
      return interaction.reply({
        content: "❌ This can only be used inside your verification thread.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (action === "verify_cancel") {
      await interaction.deferUpdate().catch(() => null);
      await thread.send("🛑 Cancelled. Run **/verify** again when you’re ready.");
      await thread.setArchived(true).catch(() => null);
      return;
    }

    if (action === "verify_retry") {
      await interaction.deferUpdate().catch(() => null);

      const url = await findLatestAttachmentUrlInThread(thread, interaction.user.id);
      if (!url) {
        await thread.send(
          "❌ I can’t find a screenshot in this thread. Upload **one** Governor Profile screenshot and press **Retry OCR** again."
        );
        return;
      }

      try {
        await runOcrAttempt(interaction.guild, thread, interaction.user.id, url, true);
      } catch (err) {
        await thread.send(
          `❌ Retry failed: **${err.message || "Unknown error"}**\nUpload a clearer screenshot (or just the bottom info panel) and press **Retry OCR** again.`
        );

        await sendVerifyLog(
          interaction.guild,
          new EmbedBuilder()
            .setTitle("❌ Verification retry failed")
            .setDescription(`User: <@${interaction.user.id}>`)
            .addFields(
              { name: "Error", value: err.message || "Unknown error" },
              { name: "Thread", value: channelJump(interaction.guildId, thread.id) }
            )
            .setTimestamp()
        );
      }

      return;
    }

    return;
  }

  // ======================
  // Slash commands
  // ======================
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "verify") {
    let thread = null;

    try {
      await interaction.reply({
        content: "✅ Creating your private verification thread…",
        flags: MessageFlags.Ephemeral
      });

      const channel = await interaction.channel.fetch();
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error("Verification must be run in a text channel.");
      }

      thread = await channel.threads.create({
        name: `verify-${interaction.user.username}`.slice(0, 100),
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        invitable: false
      });

      await thread.members.add(interaction.user.id);

      await sendVerifyLog(
        interaction.guild,
        new EmbedBuilder()
          .setTitle("🟡 Verification started")
          .setDescription(`User: <@${interaction.user.id}>`)
          .addFields({ name: "Thread", value: channelJump(interaction.guildId, thread.id) })
          .setTimestamp()
      );

      await thread.send(
        [
          "📸 Upload **one screenshot** of your Kingshot **Governor Profile**.",
          "You may upload:",
          "• Full profile screen",
          "• OR just the bottom info panel",
          "",
          "⚠️ One image only."
        ].join("\n")
      );

      const collected = await thread.awaitMessages({
        filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0,
        max: 1,
        time: 3 * 60 * 1000
      });

      if (!collected.size) {
        await thread.send({
          content: "⏳ Timed out. You can upload a screenshot and press **Retry OCR**, or run **/verify** again.",
          components: [retryRow(interaction.user.id)]
        });
        throw new Error("Timed out waiting for screenshot.");
      }

      const attachment = collected.first().attachments.first();
      if (!attachment) {
        await thread.send({
          content: "❌ No attachment found. Upload a screenshot and press **Retry OCR**.",
          components: [retryRow(interaction.user.id)]
        });
        throw new Error("No attachment found.");
      }

      await runOcrAttempt(interaction.guild, thread, interaction.user.id, attachment.url, false);
    } catch (err) {
      console.error(err);

      if (thread) {
        await thread.send({
          content: `❌ Verification failed: **${err.message || "Unknown error"}**\nUpload a clearer screenshot (or just the bottom info panel) then press **Retry OCR**.`,
          components: [retryRow(interaction.user.id)]
        });

        await sendVerifyLog(
          interaction.guild,
          new EmbedBuilder()
            .setTitle("❌ Verification failed")
            .setDescription(`User: <@${interaction.user.id}>`)
            .addFields(
              { name: "Error", value: err.message || "Unknown error" },
              { name: "Thread", value: channelJump(interaction.guildId, thread.id) }
            )
            .setTimestamp()
        );
      } else {
        await sendVerifyLog(
          interaction.guild,
          new EmbedBuilder()
            .setTitle("❌ Verification failed (no thread)")
            .setDescription(`User: <@${interaction.user.id}>`)
            .addFields({ name: "Error", value: err.message || "Unknown error" })
            .setTimestamp()
        );
      }
    }

    return;
  }
});

client.login(process.env.DISCORD_TOKEN);