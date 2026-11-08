const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder
} = require("discord.js");

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, entersState, VoiceConnectionStatus
} = require("@discordjs/voice");

const { spawn } = require("node:child_process");

// ضع ID الروم الصوتي هنا
const VOICE_CHANNEL_ID = "PUT_VOICE_CHANNEL_ID_HERE";

// هذه القيم تضيفها في Render > Environment
const { TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error("Missing TOKEN, CLIENT_ID, or GUILD_ID environment variable.");
}
if (VOICE_CHANNEL_ID === "PUT_VOICE_CHANNEL_ID_HERE") {
  throw new Error("Set VOICE_CHANNEL_ID in index.js before deploying.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const player = createAudioPlayer();
let connection = null;
let queue = [];
let processes = [];
let starting = false;

const commands = [
  new SlashCommandBuilder()
    .setName("song")
    .setDescription("تشغيل أغنية من SoundCloud")
    .addStringOption(o => o.setName("url").setDescription("رابط SoundCloud").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("تخطي الأغنية الحالية"),
  new SlashCommandBuilder().setName("stop").setDescription("إيقاف الموسيقى ومسح الطابور"),
  new SlashCommandBuilder().setName("leave").setDescription("الخروج من الروم الصوتي"),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

async function joinRoom(guild) {
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);
  if (!channel?.isVoiceBased()) throw new Error("VOICE_CHANNEL_ID is not a voice channel.");

  if (connection) connection.destroy();

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  connection.subscribe(player);
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log(`Joined voice channel: ${channel.name}`);
}

function killProcesses() {
  for (const proc of processes) {
    if (proc && !proc.killed) proc.kill();
  }
  processes = [];
}

function playNext() {
  if (starting || player.state.status === AudioPlayerStatus.Playing || !queue.length) return;

  starting = true;
  const url = queue.shift();

  const ytdlp = spawn("yt-dlp", [
    "--ignore-config", "--no-playlist", "-f", "bestaudio/best", "-o", "-", url
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
    "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["pipe", "pipe", "pipe"] });

  processes = [ytdlp, ffmpeg];
  ytdlp.stdout.pipe(ffmpeg.stdin);

  ytdlp.stderr.on("data", d => console.error("yt-dlp:", d.toString()));
  ffmpeg.stderr.on("data", d => console.error("ffmpeg:", d.toString()));

  ytdlp.on("error", err => console.error("yt-dlp error:", err));
  ffmpeg.on("error", err => console.error("ffmpeg error:", err));

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    metadata: { url },
  });

  player.play(resource);
  starting = false;
}

player.on(AudioPlayerStatus.Idle, () => {
  killProcesses();
  starting = false;
  setImmediate(playNext);
});

player.on("error", err => {
  console.error("Audio player error:", err);
  killProcesses();
  starting = false;
  setImmediate(playNext);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "song") {
      await interaction.deferReply();
      const url = interaction.options.getString("url", true).trim();

      let parsed;
      try { parsed = new URL(url); } catch {
        return interaction.editReply("الرابط غير صحيح.");
      }

      if (!["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(parsed.hostname)) {
        return interaction.editReply("أرسل رابط SoundCloud عام وصحيح.");
      }

      if (!connection) await joinRoom(interaction.guild);
      queue.push(url);
      await interaction.editReply(`تمت إضافة الأغنية للطابور:\n${url}`);
      playNext();
      return;
    }

    if (interaction.commandName === "skip") {
      if (player.state.status === AudioPlayerStatus.Idle) {
        return interaction.reply("ما فيه أغنية شغالة حاليًا.");
      }
      player.stop(true);
      return interaction.reply("تم التخطي.");
    }

    if (interaction.commandName === "stop") {
      queue = [];
      killProcesses();
      player.stop(true);
      return interaction.reply("تم إيقاف الموسيقى ومسح الطابور.");
    }

    if (interaction.commandName === "leave") {
      queue = [];
      killProcesses();
      player.stop(true);
      if (connection) connection.destroy();
      connection = null;
      return interaction.reply("خرجت من الروم.");
    }
  } catch (err) {
    console.error(err);
    const msg = "حدث خطأ. راجع Logs في Render وتأكد من الإعدادات.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await joinRoom(guild);
    console.log("Bot is ready.");
  } catch (err) {
    console.error("Auto-join failed:", err);
  }
});

async function main() {
  await registerCommands();
  await client.login(TOKEN);
}
main().catch(console.error);
