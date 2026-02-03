import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType
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

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "verify") return;

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

    await thread.send(
      "🔎 Reading screenshot… (if this takes more than a moment, it’s Tesseract being dramatic)"
    );

    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    const parsed = await extractKingshotProfile(buffer);

    const member = await interaction.guild.members.fetch(interaction.user.id);

    const newRoleIds = rolesFor(parsed.clanTag, parsed.kingdom);

    const toAdd = [CONFIG.roleVerifiedId, ...newRoleIds].filter(Boolean);
    const toRemove = [CONFIG.roleUnverifiedId].filter(Boolean);

    if (toAdd.length) await member.roles.add(toAdd);
    if (toRemove.length) await member.roles.remove(toRemove);

    upsertVerifiedUser(interaction.user.id, {
      gameId: parsed.id,
      clanTag: parsed.clanTag,
      kingdom: parsed.kingdom
    });

    await thread.send(
      [
        `✅ Verified!`,
        `• Clan: **${parsed.clanTag}**`,
        `• ID: **${parsed.id}**`,
        `• Kingdom: **#${parsed.kingdom}**`,
        ``,
        `Roles assigned. Your ID has been stored.`
      ].join("\n")
    );

    await thread.setArchived(true);
  } catch (err) {
    console.error(err);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: `❌ Verification failed: ${err.message}`,
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: `❌ Verification failed: ${err.message}`,
          ephemeral: true
        });
      }
    } catch {
      // ignore reply failures
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
