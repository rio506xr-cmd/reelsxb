import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';

// ============================================================
// الإعداد الوحيد الذي تعدّله داخل الكود: آيدي روم الصوت.
// التوكن لا تضعه هنا؛ ضعه في Render باسم DISCORD_TOKEN.
// لا يوجد TEXT_CHANNEL_ID أو GUILD_ID.
// ============================================================
const VOICE_CHANNEL_ID = '1567744230418284554';

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const PORT = Number(process.env.PORT || 10000);
const DEFAULT_VOLUME = 0.5; // من 0.0 إلى 1.0
const MAX_QUEUE_SIZE = 50;
const MAX_PANELS = 30;

if (!TOKEN) throw new Error('أضف DISCORD_TOKEN في Render Environment Variables.');
if (!/^\d{17,20}$/.test(VOICE_CHANNEL_ID)) {
  throw new Error('ضع آيدي روم الصوت الصحيح مكان PUT_VOICE_CHANNEL_ID_HERE في أعلى index.js.');
}
if (!ffmpegPath) throw new Error('لم يتم العثور على FFmpeg. تحقق من تثبيت ffmpeg-static.');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT غير صالح.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let music;
let ready = false;

// خادم HTTP مطلوب لـ Render Web Service.
const server = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? undefined : 'Method Not Allowed');
  }
  if (pathname !== '/' && pathname !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false }));
  }
  const body = JSON.stringify({
    ok: true,
    service: 'discord-music-bot',
    discord: client.isReady() ? 'ready' : 'connecting',
    voice: ready ? 'connected-or-started' : 'starting',
    uptime: Math.floor(process.uptime()),
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
});
server.listen(PORT, '0.0.0.0', () => console.log(`Web Service listening on 0.0.0.0:${PORT}`));

function safeText(value, max = 180) {
  return String(value ?? '')
    .replace(/[`*_~|>]/g, '')
    .replace(/@/g, '@\u200b')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, max) || 'مقطع صوتي';
}

function getTrackTitle(rawUrl, customTitle) {
  if (customTitle?.trim()) return safeText(customTitle.trim());
  const url = new URL(rawUrl);
  const fileName = path.posix.basename(url.pathname).replace(/\.[a-z0-9]{2,5}$/i, '');
  return safeText(decodeURIComponent(fileName || url.hostname));
}

function validateAudioUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('الرابط غير صحيح. أرسل رابط HTTPS كاملاً.'); }
  if (url.protocol !== 'https:') throw new Error('يجب أن يبدأ الرابط بـ https://');
  if (url.username || url.password) throw new Error('الروابط التي تتضمن بيانات دخول غير مدعومة.');
  const host = url.hostname.toLowerCase();
  if (
    host === 'soundcloud.com' || host.endsWith('.soundcloud.com') ||
    host === 'snd.sc' || host.endsWith('.snd.sc') ||
    host === 'sndcdn.com' || host.endsWith('.sndcdn.com')
  ) {
    throw new Error('رابط صفحة SoundCloud غير مدعوم. أرسل رابط بث صوتي مباشر ومصرّح بتشغيله بدلاً منه.');
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('هذا المضيف غير مسموح.');
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1') {
    throw new Error('لا يمكن تشغيل رابط يشير إلى عنوان محلي أو خاص.');
  }
  const audioExtension = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)(?:$|\/)/i.test(url.pathname);
  if (!audioExtension) {
    throw new Error('أرسل رابط ملف صوتي مباشر بامتداد MP3 أو M4A أو AAC أو WAV أو OGG أو OPUS أو FLAC.');
  }
  return url.toString();
}

function createMusicState(guild, voiceChannel) {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const state = {
    guildId: guild.id,
    guild,
    voiceChannelId: voiceChannel.id,
    player,
    connection: null,
    queue: [],
    current: null,
    panels: new Map(),
    ffmpeg: null,
    advancing: false,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    stopFfmpeg(state);
    state.current = null;
    void playNext(state);
    void refreshPanels(state);
  });
  player.on('error', error => {
    console.error('Audio player error:', error);
    stopFfmpeg(state);
    state.current = null;
    void playNext(state);
    void refreshPanels(state);
  });
  return state;
}

function stopFfmpeg(state) {
  const child = state.ffmpeg;
  state.ffmpeg = null;
  if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
}

function queueDescription(state) {
  const lines = [];
  if (state.current) lines.push(`**يعمل الآن:** ${safeText(state.current.title)}`);
  else lines.push('**لا يوجد مقطع يعمل حالياً.**');
  if (state.queue.length) {
    lines.push('', '**القائمة التالية:**');
    state.queue.slice(0, 10).forEach((track, index) => lines.push(`${index + 1}. ${safeText(track.title)}`));
    if (state.queue.length > 10) lines.push(`... و ${state.queue.length - 10} مقاطع أخرى`);
  } else {
    lines.push('', 'قائمة الانتظار فارغة.');
  }
  return lines.join('\n').slice(0, 3900);
}

function makePanel(state) {
  const paused = state.player.state.status === AudioPlayerStatus.Paused;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 مشغل الموسيقى')
    .setDescription(queueDescription(state))
    .addFields(
      { name: 'روم الصوت', value: `<#${state.voiceChannelId}>`, inline: true },
      { name: 'عدد الانتظار', value: String(state.queue.length), inline: true },
    )
    .setFooter({ text: 'استخدم الأزرار للتحكم بالتشغيل' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:pause').setLabel('إيقاف مؤقت').setEmoji('⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!state.current || paused),
    new ButtonBuilder().setCustomId('music:resume').setLabel('استئناف').setEmoji('▶️').setStyle(ButtonStyle.Success).setDisabled(!paused),
    new ButtonBuilder().setCustomId('music:skip').setLabel('تخطي').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(!state.current && state.queue.length === 0),
    new ButtonBuilder().setCustomId('music:stop').setLabel('إيقاف ومسح').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!state.current && state.queue.length === 0),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

async function refreshPanels(state) {
  const payload = makePanel(state);
  for (const [id, message] of state.panels) {
    try { await message.edit(payload); }
    catch (error) {
      if ([10008, 10003, 50001, 50013].includes(error.code)) state.panels.delete(id);
      else console.warn('Could not update a music panel:', error.message);
    }
  }
}

async function playNext(state) {
  if (state.advancing || state.player.state.status !== AudioPlayerStatus.Idle) return;
  state.advancing = true;
  try {
    while (state.queue.length && state.player.state.status === AudioPlayerStatus.Idle) {
      const track = state.queue.shift();
      let child;
      try {
        child = spawn(ffmpegPath, [
          '-nostdin', '-hide_banner', '-loglevel', 'error',
          '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
          '-i', track.url, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        state.ffmpeg = child;
        let stderr = '';
        child.stderr.on('data', chunk => { if (stderr.length < 3000) stderr += chunk.toString(); });
        child.once('error', error => {
          console.error('FFmpeg failed:', error);
          if (state.current?.id === track.id) state.player.stop(true);
        });
        child.once('close', code => {
          if (code && code !== 255) console.error(`FFmpeg exit ${code}: ${stderr.slice(0, 1000)}`);
        });
        const resource = createAudioResource(child.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
        resource.volume?.setVolume(DEFAULT_VOLUME);
        state.current = track;
        state.player.play(resource);
        console.log(`Now playing: ${track.title}`);
        break;
      } catch (error) {
        if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
        state.ffmpeg = null;
        state.current = null;
        console.error(`Could not play ${track.title}:`, error);
      }
    }
  } finally {
    state.advancing = false;
  }
  await refreshPanels(state);
}

async function connectVoice(guild, voiceChannel) {
  const existing = getVoiceConnection(guild.id);
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
    existing.destroy();
  }
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  music.connection = connection;
  connection.subscribe(music.player);
  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      });
    }
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log(`Connected to voice channel ${voiceChannel.name} (${voiceChannel.id})`);
}

const commands = [
  new SlashCommandBuilder()
    .setName('song')
    .setDescription('إضافة مقطع صوتي إلى قائمة التشغيل')
    .addStringOption(option => option.setName('url').setDescription('رابط ملف صوتي مباشر').setRequired(true))
    .addStringOption(option => option.setName('title').setDescription('اسم اختياري للمقطع').setRequired(false)),
  new SlashCommandBuilder().setName('queue').setDescription('عرض قائمة التشغيل'),
  new SlashCommandBuilder().setName('pause').setDescription('إيقاف المقطع مؤقتاً'),
  new SlashCommandBuilder().setName('resume').setDescription('استئناف المقطع'),
  new SlashCommandBuilder().setName('skip').setDescription('تخطي المقطع الحالي'),
  new SlashCommandBuilder().setName('stop').setDescription('إيقاف التشغيل ومسح القائمة'),
].map(command => command.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
  console.log(`Registered music slash commands in guild ${guildId}`);
}

async function handleCommand(interaction) {
  if (interaction.isButton()) {
    if (!music || interaction.guildId !== music.guildId) {
      await interaction.reply({ content: 'البوت غير مهيأ لهذا السيرفر.', ephemeral: true });
      return;
    }
    try {
      switch (interaction.customId) {
        case 'music:pause':
          if (!music.current || music.player.state.status === AudioPlayerStatus.Paused || !music.player.pause()) {
            throw new Error('لا يوجد مقطع يعمل لإيقافه مؤقتاً.');
          }
          break;
        case 'music:resume':
          if (music.player.state.status !== AudioPlayerStatus.Paused || !music.player.unpause()) {
            throw new Error('لا يوجد مقطع متوقف مؤقتاً لاستئنافه.');
          }
          break;
        case 'music:skip':
          if (!music.current && !music.queue.length) throw new Error('قائمة التشغيل فارغة.');
          music.player.stop(true);
          break;
        case 'music:stop':
          music.queue.length = 0;
          music.current = null;
          stopFfmpeg(music);
          music.player.stop(true);
          break;
        default:
          throw new Error('هذا الزر غير معروف.');
      }
      await refreshPanels(music);
      await interaction.reply({ content: 'تم تنفيذ التحكم وتحديث القائمة.', ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `⚠️ ${error.message}`.slice(0, 1900), ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!music || interaction.guildId !== music.guildId) {
    await interaction.reply({ content: 'البوت غير مهيأ لهذا السيرفر.', ephemeral: true });
    return;
  }

  const name = interaction.commandName;
  try {
    if (name === 'song') {
      const rawUrl = interaction.options.getString('url', true).trim();
      const url = validateAudioUrl(rawUrl);
      const title = getTrackTitle(url, interaction.options.getString('title'));
      await interaction.deferReply();
      if (!music.connection || music.connection.state.status !== VoiceConnectionStatus.Ready) {
        await connectVoice(music.guild, await music.guild.channels.fetch(VOICE_CHANNEL_ID));
      }
      if (music.queue.length >= MAX_QUEUE_SIZE) throw new Error(`قائمة الانتظار ممتلئة (الحد ${MAX_QUEUE_SIZE} مقطع).`);
      const track = {
        id: randomUUID(),
        url,
        title,
        requestedBy: safeText(interaction.user.username),
      };
      const startsNow = !music.current && music.player.state.status === AudioPlayerStatus.Idle;
      music.queue.push(track);
      if (startsNow) await playNext(music);
      const response = makePanel(music);
      response.content = startsNow ? `✅ تمت إضافة **${title}** وبدأ تشغيله.` : `✅ تمت إضافة **${title}** إلى قائمة الانتظار.`;
      await interaction.editReply(response);
      const replyMessage = await interaction.fetchReply();
      music.panels.set(replyMessage.id, replyMessage);
      while (music.panels.size > MAX_PANELS) music.panels.delete(music.panels.keys().next().value);
      await refreshPanels(music);
      return;
    }

    if (name === 'queue') {
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📃 قائمة التشغيل').setDescription(queueDescription(music))], ephemeral: true });
      return;
    }

    if (name === 'pause') {
      if (!music.current) throw new Error('ما فيه مقطع يعمل حالياً.');
      if (!music.player.pause()) throw new Error('تعذر إيقاف المقطع مؤقتاً.');
    } else if (name === 'resume') {
      if (music.player.state.status !== AudioPlayerStatus.Paused || !music.player.unpause()) throw new Error('ما فيه مقطع متوقف مؤقتاً.');
    } else if (name === 'skip') {
      if (!music.current && !music.queue.length) throw new Error('قائمة التشغيل فارغة.');
      music.player.stop(true);
    } else if (name === 'stop') {
      music.queue.length = 0;
      music.current = null;
      stopFfmpeg(music);
      music.player.stop(true);
    }

    await refreshPanels(music);
    await interaction.reply({ content: 'تم تنفيذ الأمر وتحديث قائمة التشغيل في رسالة الأغنية.', ephemeral: true });
  } catch (error) {
    const message = `⚠️ ${error.message || 'حدث خطأ غير متوقع.'}`.slice(0, 1900);
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  try {
    const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID);
    if (!voiceChannel?.isVoiceBased() || !voiceChannel.guild) throw new Error('آيدي روم الصوت لا يشير إلى روم صوتي صالح.');
    music = createMusicState(voiceChannel.guild, voiceChannel);
    await connectVoice(voiceChannel.guild, voiceChannel);
    await registerCommands(voiceChannel.guild.id);
    ready = true;
    console.log('Music bot is ready. Run /song in any text channel in this server.');
  } catch (error) {
    console.error('Bot setup failed:', error);
    ready = false;
  }
});

client.on(Events.InteractionCreate, interaction => { void handleCommand(interaction); });

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  ready = false;
  if (music) {
    music.queue.length = 0;
    stopFfmpeg(music);
    music.player.stop(true);
    music.connection?.destroy();
  }
  server.close();
  client.destroy();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

client.login(TOKEN).catch(error => {
  console.error('Discord login failed:', error);
  process.exitCode = 1;
});
