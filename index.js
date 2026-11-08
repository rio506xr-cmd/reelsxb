'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');

// ضع هنا ID الروم الصوتي. البوت يدخل هذا الروم تلقائياً عند التشغيل.
// مثال: const VOICE_CHANNEL_ID = '123456789012345678';
const VOICE_CHANNEL_ID = 'PUT_YOUR_VOICE_CHANNEL_ID_HERE';

const MAX_QUEUE = Math.max(1, Number(process.env.MAX_QUEUE || 50));
const YTDLP_PATH = process.env.YTDLP_PATH || (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 30_000;

// أوامر Slash تُسجّل على كل تطبيق بوت. الردود خاصة (Ephemeral).
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('يدخل أول بوت متاح إلى الروم المحدد في الكود')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('song')
    .setDescription('يشغّل رابطاً أو يضيفه إلى قائمة التشغيل')
    .addStringOption((option) => option
      .setName('url')
      .setDescription('رابط يوتيوب أو ساوند كلاود أو أي مصدر يدعمه yt-dlp')
      .setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('يوقف الموسيقى ويُخرج البوت من الروم')
    .toJSON(),
];

function readTokens() {
  // Render and other hosts expose secrets as environment variables.
  // TOKENS supports multiple tokens separated by newlines, commas or semicolons.
  const envKeys = [
    'TOKENS',
    'DISCORD_TOKENS',
    'BOT_TOKENS',
    'DISCORD_TOKEN',
    'DISCORD_BOT_TOKEN',
    'BOT_TOKEN',
    'TOKEN',
  ];
  const envKey = envKeys.find((key) => typeof process.env[key] === 'string' && process.env[key].trim());
  let rows = [];

  if (envKey) {
    rows = process.env[envKey].split(/[\r\n,;]+/g);
    console.log(`[Config] Loaded bot token(s) from Environment Variable: ${envKey}`);
  } else {
    const tokenFile = path.join(__dirname, 'tokens.txt');
    if (!fs.existsSync(tokenFile)) {
      throw new Error(
        'ما حصلت أي توكن في Environment Variables. أضف متغير باسم TOKENS (أو TOKEN لبوت واحد) وحط التوكن في خانة Value، ثم أعد Deploy. محلياً تقدر تستخدم tokens.txt.'
      );
    }
    rows = fs.readFileSync(tokenFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/g);
    console.log('[Config] Loaded bot token(s) from tokens.txt');
  }

  const tokens = [...new Set(rows.map((line) => line.trim()).filter((line) => line && !line.startsWith('#')))];
  if (!tokens.length) {
    throw new Error(`متغير البيئة ${envKey || 'TOKENS'} موجود لكنه فاضي. حط التوكن في خانة Value بدون كتابة اسم المتغير معها.`);
  }
  return tokens;
}

const bots = [];
const startLocks = new Set();

function log(bot, message) {
  const prefix = bot?.client?.user?.tag || bot?.label || 'MusicBot';
  console.log(`[${new Date().toISOString()}] [${prefix}] ${message}`);
}

function clip(value, max = 180) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'غير معروف';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function shortUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname.length > 32 ? `${parsed.pathname.slice(0, 31)}…` : parsed.pathname}`;
  } catch {
    return clip(value, 70);
  }
}

function trackName(track) {
  return clip(track?.title || shortUrl(track?.inputUrl || ''), 180) || 'مقطع بدون اسم';
}

function makePanelEmbed(state) {
  const paused = state.player.state.status === AudioPlayerStatus.Paused;
  const playing = state.player.state.status === AudioPlayerStatus.Playing;
  const loading = Boolean(state.loading);
  const current = state.currentTrack;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎵 مشغّل الموسيقى')
    .setDescription(
      current
        ? `**الحين:** ${trackName(current)}`
        : loading
          ? '**جاري تجهيز المقطع...**'
          : '**ما فيه مقطع شغّال حالياً**',
    )
    .addFields(
      { name: 'الحالة', value: paused ? '⏸️ متوقف مؤقتاً' : playing ? '▶️ شغّال' : loading ? '⏳ جاري التحميل' : '⏹️ متوقف', inline: true },
      { name: 'المدة', value: current?.duration ? formatDuration(current.duration) : '—', inline: true },
      { name: 'القائمة', value: `${state.queue.length} مقطع`, inline: true },
    )
    .setFooter({ text: `البوت: ${state.bot.client.user.username}` });

  if (current?.webpageUrl) {
    try {
      const url = new URL(current.webpageUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') embed.setURL(url.toString());
    } catch { /* تجاهل الروابط غير الصالحة في الـ Embed */ }
  }

  const next = state.queue[0];
  if (next) embed.addFields({ name: 'التالي', value: trackName(next).slice(0, 1024), inline: false });
  return embed;
}

function makePanelComponents(state) {
  const canPause = Boolean(state.currentTrack) && !state.loading;
  const paused = state.player.state.status === AudioPlayerStatus.Paused;
  const canPrevious = state.history.length > 0;
  const canNext = state.queue.length > 0 || Boolean(state.currentTrack);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:prev`)
      .setLabel('السابقة')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPrevious),
    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:pause`)
      .setLabel(paused ? 'تشغيل' : 'إيقاف مؤقت')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canPause),
    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:next`)
      .setLabel('التالية')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canNext),
    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:list`)
      .setLabel('Playlist')
      .setEmoji('📃')
      .setStyle(ButtonStyle.Success),
  );
  return [row];
}

async function updatePanel(state) {
  if (state.closing || !state.panelChannelId) return;

  state.panelUpdate = (state.panelUpdate || Promise.resolve()).then(async () => {
    if (state.closing) return;
    const payload = {
      embeds: [makePanelEmbed(state)],
      components: makePanelComponents(state),
      allowedMentions: { parse: [] },
    };

    if (state.panelMessage) {
      try {
        await state.panelMessage.edit(payload);
        return;
      } catch {
        state.panelMessage = null;
      }
    }

    const channel = await state.bot.client.channels.fetch(state.panelChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') return;
    state.panelMessage = await channel.send(payload).catch((error) => {
      log(state.bot, `تعذر إرسال لوحة التحكم: ${error.message}`);
      return null;
    });
  }).catch((error) => log(state.bot, `خطأ تحديث اللوحة: ${error.message}`));

  return state.panelUpdate;
}

function runYtDlp(inputUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--ignore-config',
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      '--socket-timeout', '20',
      '--extractor-retries', '2',
      '--fragment-retries', '2',
      '--format', 'bestaudio/best',
      '--js-runtimes', 'deno',
      '--dump-single-json',
      inputUrl,
    ];

    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    let timer = null;

    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(data);
    };

    try {
      child = spawn(YTDLP_PATH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(new Error(`تعذر تشغيل yt-dlp: ${error.message}`));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 15 * 1024 * 1024) {
        child.kill();
        finish(new Error('بيانات الرابط أكبر من المتوقع.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-7000);
    });
    child.once('error', (error) => {
      finish(new Error(`ما قدرت أشغل yt-dlp. تأكد إنه مثبت ومضاف إلى PATH. ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        if (/DRM protected|cbc-encrypted-hls|ctr-encrypted-hls/i.test(stderr)) {
          finish(new Error(
            'هذا المقطع من SoundCloud محمي بـ DRM، وyt-dlp ما يدعم تشغيل هذا النوع. جرّب رابطاً آخر لنفس الأغنية من مصدر غير محمي أو نسخة متاحة للبث.'
          ));
          return;
        }
        const detail = clip(stderr || `exit code ${code}`, 700);
        finish(new Error(`yt-dlp ما قدر يستخرج الرابط: ${detail}`));
        return;
      }
      try {
        const info = JSON.parse(stdout.trim());
        if (!info.url) throw new Error('المصدر ما رجّع رابط بث مباشر.');
        finish(null, info);
      } catch (error) {
        finish(new Error(`تعذر قراءة نتيجة yt-dlp: ${error.message}`));
      }
    });

    timer = setTimeout(() => {
      child.kill();
      finish(new Error('انتهت مهلة استخراج الرابط. جرّب رابطاً آخر أو حدّث yt-dlp.'));
    }, YTDLP_TIMEOUT_MS);
    timer.unref?.();
  });
}

function makeFfmpegArgs(info) {
  const headers = info.http_headers && typeof info.http_headers === 'object'
    ? Object.entries(info.http_headers)
        .map(([key, value]) => `${key}: ${String(value).replace(/[\r\n]/g, '')}\r\n`)
        .join('')
    : '';

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];

  if (headers) args.push('-headers', headers);
  args.push(
    '-i', info.url,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  );
  return args;
}

function cleanupFfmpeg(state) {
  const proc = state.ffmpeg;
  state.ffmpeg = null;
  if (proc && proc.exitCode === null && !proc.killed) {
    try { proc.kill(); } catch { /* انتهى مسبقاً */ }
  }
}

function sendToPanelChannel(state, content) {
  return state.bot.client.channels.fetch(state.panelChannelId)
    .then((channel) => channel?.isTextBased() && typeof channel.send === 'function'
      ? channel.send({ content: clip(content, 1900), allowedMentions: { parse: [] } })
      : null)
    .catch((error) => log(state.bot, `تعذر إرسال التنبيه: ${error.message}`));
}

async function playNext(state) {
  if (state.closing || state.loading || state.currentTrack || !state.queue.length) {
    await updatePanel(state);
    return;
  }

  const track = state.queue.shift();
  state.currentTrack = track;
  state.loading = true;
  const generation = ++state.generation;
  await updatePanel(state);

  try {
    const info = await runYtDlp(track.inputUrl);
    if (state.closing || generation !== state.generation) return;

    track.title = info.title || track.title || shortUrl(track.inputUrl);
    track.duration = Number(info.duration) || null;
    track.webpageUrl = info.webpage_url || track.inputUrl;

    const ffmpeg = spawn(FFMPEG_PATH, makeFfmpegArgs(info), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.ffmpeg = ffmpeg;
    let ffmpegError = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk) => { ffmpegError = (ffmpegError + chunk).slice(-4000); });

    ffmpeg.once('error', async (error) => {
      if (state.closing || generation !== state.generation) return;
      state.ffmpeg = null;
      await sendToPanelChannel(state, `تعذر تشغيل FFmpeg. تأكد إنه مثبت ومضاف إلى PATH. ${error.message}`);
      if (state.player.state.status !== AudioPlayerStatus.Idle) {
        state.suppressHistoryOnce = true;
        state.player.stop(true);
      } else {
        state.currentTrack = null;
        state.loading = false;
        state.generation += 1;
        void playNext(state);
      }
    });

    ffmpeg.once('close', (code) => {
      if (state.ffmpeg === ffmpeg) state.ffmpeg = null;
      if (code && code !== 0 && !state.closing && generation === state.generation && ffmpegError) {
        log(state.bot, `FFmpeg انتهى برمز ${code}: ${clip(ffmpegError, 500)}`);
      }
    });

    if (state.closing || generation !== state.generation) {
      try { ffmpeg.kill(); } catch { /* تجاهل */ }
      return;
    }

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      metadata: track,
    });
    state.loading = false;
    state.player.play(resource);
    await updatePanel(state);
    log(state.bot, `بدأ التشغيل: ${trackName(track)}`);
  } catch (error) {
    if (state.closing || generation !== state.generation) return;
    cleanupFfmpeg(state);
    state.currentTrack = null;
    state.loading = false;
    state.generation += 1;
    await sendToPanelChannel(state, `ما قدرت أشغّل المقطع: ${clip(error.message, 900)}`);
    await updatePanel(state);
    void playNext(state);
  }
}

function handlePlayerIdle(state) {
  if (state.closing) return;
  cleanupFfmpeg(state);

  const ended = state.currentTrack;
  state.currentTrack = null;
  state.loading = false;

  if (ended && !state.suppressHistoryOnce) {
    state.history.push(ended);
    if (state.history.length > 30) state.history.shift();
  }
  state.suppressHistoryOnce = false;
  void updatePanel(state);
  void playNext(state);
}

function createSession(bot, guild, voiceChannel, textChannelId) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  const state = {
    bot,
    guildId: guild.id,
    channelId: voiceChannel.id,
    panelChannelId: textChannelId,
    panelMessage: null,
    panelUpdate: Promise.resolve(),
    connection: null,
    player,
    ffmpeg: null,
    queue: [],
    history: [],
    currentTrack: null,
    loading: false,
    closing: false,
    generation: 0,
    suppressHistoryOnce: false,
  };

  player.on(AudioPlayerStatus.Idle, () => handlePlayerIdle(state));
  player.on('error', (error) => {
    log(bot, `خطأ بالمشغّل: ${error.message}`);
    if (!state.closing && state.player.state.status !== AudioPlayerStatus.Idle) {
      state.player.stop(true);
    }
  });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    group: `${bot.client.user.id}:${guild.id}`,
  });
  state.connection = connection;
  connection.subscribe(player);
  connection.on('error', (error) => log(bot, `خطأ اتصال الصوت: ${error.message}`));

  return state;
}

async function closeSession(state, reason = 'تم إيقاف التشغيل') {
  if (!state || state.closing) return;
  state.closing = true;
  state.generation += 1;
  cleanupFfmpeg(state);

  try { state.player.stop(true); } catch { /* تجاهل */ }
  try { state.connection?.destroy(); } catch { /* تجاهل */ }
  state.bot.sessions.delete(state.guildId);

  if (state.panelMessage) {
    const stopped = new EmbedBuilder()
      .setColor(0x747F8D)
      .setTitle('⏹️ تم إيقاف مشغّل الموسيقى')
      .setDescription(reason);
    await state.panelMessage.edit({ embeds: [stopped], components: [] }).catch(() => null);
  }
}

function findSession(guildId, voiceChannelId) {
  return bots
    .map((bot) => bot.sessions.get(guildId))
    .find((state) => state && !state.closing && state.channelId === voiceChannelId) || null;
}

async function deferPrivate(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function replyPrivate(interaction, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function getInteractionVoiceChannelId(interaction) {
  if (!interaction.guild) return null;
  const cached = interaction.guild.voiceStates.cache.get(interaction.user.id)?.channelId;
  if (cached) return cached;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return member?.voice?.channelId || null;
}

async function handleStart(interaction) {
  await deferPrivate(interaction);

  if (!interaction.guild) {
    await replyPrivate(interaction, 'الأمر يشتغل داخل السيرفر فقط.');
    return;
  }
  if (!/^\d{17,20}$/.test(String(VOICE_CHANNEL_ID || ''))) {
    await replyPrivate(interaction, 'حط ID الروم الصوتي الصحيح داخل index.js عند VOICE_CHANNEL_ID.');
    return;
  }

  const guildId = interaction.guildId;
  if (startLocks.has(guildId)) {
    await replyPrivate(interaction, 'فيه أمر تشغيل قاعد يتنفّذ، جرّب بعد لحظة.');
    return;
  }
  startLocks.add(guildId);

  try {
    const existing = findSession(guildId, VOICE_CHANNEL_ID);
    if (existing) {
      await replyPrivate(interaction, `فيه بوت شغّال من قبل في <#${VOICE_CHANNEL_ID}>.`);
      return;
    }

    let selected = null;
    let selectedGuild = null;
    for (const bot of bots) {
      if (!bot.ready || bot.sessions.has(guildId)) continue;
      const guild = bot.client.guilds.cache.get(guildId)
        || await bot.client.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;
      selected = bot;
      selectedGuild = guild;
      break;
    }

    if (!selected || !selectedGuild) {
      await replyPrivate(interaction, 'ما فيه بوت فاضي ومضاف للسيرفر. تأكد إن كل البوتات موجودة بالسيرفر.');
      return;
    }

    const voiceChannel = await selectedGuild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      await replyPrivate(interaction, 'ID المحدد مو لروم صوتي عادي أو مو موجود في نفس السيرفر.');
      return;
    }

    const permissions = voiceChannel.permissionsFor(selected.client.user);
    if (!permissions?.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])) {
      await replyPrivate(interaction, 'البوت ما عنده صلاحية Connect و Speak في الروم.');
      return;
    }

    let state;
    try {
      state = createSession(selected, selectedGuild, voiceChannel, interaction.channelId);
      selected.sessions.set(guildId, state);
      await entersState(state.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (error) {
      if (state) await closeSession(state, 'تعذر الاتصال بالروم الصوتي.').catch(() => null);
      await replyPrivate(interaction, `ما قدرت أوصل للروم الصوتي: ${clip(error.message, 700)}`);
      return;
    }

    await replyPrivate(interaction, `دخل **${selected.client.user.username}** إلى <#${VOICE_CHANNEL_ID}>.`);
    log(selected, `دخل الروم ${voiceChannel.name} في السيرفر ${guildId}`);
  } finally {
    startLocks.delete(guildId);
  }
}

async function handleSong(interaction, rawUrl) {
  await deferPrivate(interaction);
  if (!interaction.guild) {
    await replyPrivate(interaction, 'الأمر يشتغل داخل السيرفر فقط.');
    return;
  }

  const voiceChannelId = await getInteractionVoiceChannelId(interaction);
  if (!voiceChannelId) {
    await replyPrivate(interaction, 'ادخل الروم الصوتي أول، ثم استخدم الأمر.');
    return;
  }

  // ابحث عن جلسة البوت الموجود في روم العضو؛ كل جلسة وقائمتها تخص بوتاً واحداً فقط.
  const state = findSession(interaction.guildId, voiceChannelId);
  if (!state) {
    await replyPrivate(interaction, 'ما فيه بوت مشغّل في رومك. استخدم `/start` لإدخال أول بوت متاح للروم المحدد بالكود.');
    return;
  }

  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    await replyPrivate(interaction, 'حط رابط صحيح يبدأ بـ http أو https.');
    return;
  }

  if (state.queue.length + (state.currentTrack ? 1 : 0) >= MAX_QUEUE) {
    await replyPrivate(interaction, `القائمة ممتلئة. الحد الأعلى ${MAX_QUEUE} مقطع.`);
    return;
  }

  const track = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    inputUrl: parsed.toString(),
    title: null,
    duration: null,
    webpageUrl: parsed.toString(),
    requestedBy: interaction.user.username,
  };
  state.queue.push(track);
  if (!state.panelMessage && !state.loading && !state.currentTrack) {
    state.panelChannelId = interaction.channelId;
  }

  await replyPrivate(interaction, 'تمت إضافة المقطع للقائمة. 🎶');
  await updatePanel(state);
  if (!state.loading && !state.currentTrack && state.player.state.status === AudioPlayerStatus.Idle) {
    void playNext(state);
  }
}

async function handleStop(interaction) {
  await deferPrivate(interaction);
  if (!interaction.guild) {
    await replyPrivate(interaction, 'الأمر يشتغل داخل السيرفر فقط.');
    return;
  }

  const voiceChannelId = await getInteractionVoiceChannelId(interaction);
  if (!voiceChannelId) {
    await replyPrivate(interaction, 'ادخل الروم الصوتي اللي فيه البوت واستخدم الأمر.');
    return;
  }

  const state = findSession(interaction.guildId, voiceChannelId);
  if (!state) {
    await replyPrivate(interaction, 'ما فيه بوت شغّال في رومك.');
    return;
  }

  await replyPrivate(interaction, `تم إيقاف **${state.bot.client.user.username}** وخروجه من الروم.`);
  await closeSession(state, 'تم إيقاف الأغنية وطلع البوت من الروم.');
}

async function handleSlashCommand(bot, interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'start') {
    await handleStart(interaction);
    return;
  }
  if (interaction.commandName === 'song') {
    await handleSong(interaction, interaction.options.getString('url', true));
    return;
  }
  if (interaction.commandName === 'stop') {
    await handleStop(interaction);
  }
}

async function registerSlashCommands(bot) {
  // كل تطبيق بوت يسجل الأوامر نفسها؛ لذلك تقدر تستخدم /start و/song و/stop من أي بوت.
  await bot.client.application.commands.set(SLASH_COMMANDS);
  log(bot, 'تم تسجيل أوامر Slash: /start /song /stop');
}

async function autoJoinConfiguredRoom() {
  if (!/^\d{17,20}$/.test(VOICE_CHANNEL_ID)) {
    console.error('[Config] حط ID الروم الصوتي الصحيح في index.js عند VOICE_CHANNEL_ID.');
    return;
  }

  let lastReason = 'ما لقيت بوت جاهز ومضاف للسيرفر اللي فيه الروم.';

  for (const bot of bots) {
    if (!bot.ready) continue;

    const voiceChannel = await bot.client.channels.fetch(VOICE_CHANNEL_ID).catch((error) => {
      lastReason = error.message;
      return null;
    });

    if (!voiceChannel) continue;
    if (voiceChannel.type !== ChannelType.GuildVoice) {
      lastReason = 'ID المحدد مو لروم صوتي عادي. تأكد من ID الروم.';
      continue;
    }

    const guild = voiceChannel.guild;
    if (bots.some((candidate) => candidate.sessions.has(guild.id))) {
      log(bot, `فيه جلسة صوتية شغالة مسبقاً في السيرفر ${guild.id}؛ ما راح أدخل بوت ثاني.`);
      return;
    }

    const permissions = voiceChannel.permissionsFor(bot.client.user);
    if (!permissions?.has([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])) {
      lastReason = `البوت ${bot.client.user.tag} ما عنده صلاحية Connect و Speak في الروم.`;
      continue;
    }

    if (startLocks.has(guild.id)) continue;
    startLocks.add(guild.id);

    let state;
    try {
      state = createSession(bot, guild, voiceChannel, null);
      bot.sessions.set(guild.id, state);
      await entersState(state.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      log(bot, `دخل تلقائياً الروم المحدد: ${voiceChannel.name} (${VOICE_CHANNEL_ID})`);
      return;
    } catch (error) {
      lastReason = error.message;
      if (state) await closeSession(state, 'تعذر الاتصال بالروم الصوتي.').catch(() => null);
      log(bot, `فشل الدخول التلقائي للروم: ${error.message}`);
    } finally {
      startLocks.delete(guild.id);
    }
  }

  console.error(`[Voice] ما قدرت أدخل الروم ${VOICE_CHANNEL_ID}: ${lastReason}`);
}

function makePlaylistEmbed(state) {
  const lines = [];
  if (state.currentTrack) lines.push(`**الحين:** ${trackName(state.currentTrack)}`);
  else if (state.loading) lines.push('**الحين:** جاري تجهيز المقطع...');
  else lines.push('**الحين:** ما فيه شيء شغّال');

  if (state.queue.length) {
    lines.push('', '**القائمة:**');
    state.queue.slice(0, 25).forEach((track, index) => {
      lines.push(`${index + 1}. ${trackName(track)}`);
    });
    if (state.queue.length > 25) lines.push(`... و ${state.queue.length - 25} مقطع إضافي`);
  } else {
    lines.push('', 'القائمة فاضية.');
  }

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('📃 قائمة التشغيل')
    .setDescription(lines.join('\n').slice(0, 4000));
}

async function handleButton(bot, interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('music:')) return;
  const [, botId, guildId, action] = interaction.customId.split(':');
  if (!botId || !guildId || !action || botId !== bot.client.user.id) return;

  const state = bot.sessions.get(guildId);
  if (!state || state.closing) {
    await interaction.reply({ content: 'جلسة الموسيقى انتهت.', ephemeral: true }).catch(() => null);
    return;
  }

  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member || member.voice.channelId !== state.channelId) {
    await interaction.reply({ content: 'لازم تكون في نفس الروم الصوتي عشان تتحكم.', ephemeral: true }).catch(() => null);
    return;
  }

  if (action === 'list') {
    await interaction.reply({ embeds: [makePlaylistEmbed(state)], ephemeral: true }).catch(() => null);
    return;
  }

  if (action === 'pause') {
    if (state.player.state.status === AudioPlayerStatus.Paused) {
      state.player.unpause();
    } else if (state.player.state.status === AudioPlayerStatus.Playing) {
      state.player.pause();
    } else {
      await interaction.reply({ content: 'ما فيه مقطع جاهز للتحكم فيه للحين.', ephemeral: true }).catch(() => null);
      return;
    }
    await interaction.deferUpdate().catch(() => null);
    await updatePanel(state);
    return;
  }

  if (action === 'next') {
    if (!state.currentTrack && !state.loading) {
      await interaction.reply({ content: 'ما فيه مقطع حالي للتخطي.', ephemeral: true }).catch(() => null);
      return;
    }
    await interaction.deferUpdate().catch(() => null);
    if (state.loading && state.player.state.status === AudioPlayerStatus.Idle) {
      state.generation += 1;
      state.currentTrack = null;
      state.loading = false;
      cleanupFfmpeg(state);
      void playNext(state);
    } else {
      state.player.stop(true);
    }
    await updatePanel(state);
    return;
  }

  if (action === 'prev') {
    const previous = state.history.pop();
    if (!previous) {
      await interaction.reply({ content: 'ما فيه مقطع سابق.', ephemeral: true }).catch(() => null);
      return;
    }

    const current = state.currentTrack;
    if (current) state.queue.unshift(current);
    state.queue.unshift(previous);
    await interaction.deferUpdate().catch(() => null);

    if (state.loading && state.player.state.status === AudioPlayerStatus.Idle) {
      state.generation += 1;
      state.currentTrack = null;
      state.loading = false;
      cleanupFfmpeg(state);
      void playNext(state);
    } else if (state.player.state.status === AudioPlayerStatus.Idle) {
      void playNext(state);
    } else {
      state.suppressHistoryOnce = true;
      state.player.stop(true);
    }
    await updatePanel(state);
  }
}

function attachBot(bot) {
  bot.readyPromise = new Promise((resolve) => {
    bot.client.once(Events.ClientReady, (client) => {
      bot.ready = true;
      log(bot, `جاهز — ${client.user.tag}`);
      resolve(client);
    });
  });

  bot.client.on(Events.InteractionCreate, (interaction) => {
    const task = interaction.isButton()
      ? handleButton(bot, interaction)
      : handleSlashCommand(bot, interaction);
    void task.catch(async (error) => {
      log(bot, `خطأ في التفاعل: ${error.stack || error.message}`);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'صار خطأ أثناء تنفيذ الأمر.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => null);
      } else if (interaction.isRepliable() && interaction.deferred) {
        await interaction.editReply({ content: 'صار خطأ أثناء تنفيذ الأمر.' }).catch(() => null);
      }
    });
  });

  bot.client.on('error', (error) => log(bot, `Discord client error: ${error.message}`));
}

async function main() {
  let tokens;
  try {
    tokens = readTokens();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  console.log(`جاري تشغيل ${tokens.length} بوت...`);
  for (let index = 0; index < tokens.length; index += 1) {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    const bot = {
      label: `Bot ${index + 1}`,
      client,
      ready: false,
      // جلسات مستقلة لكل بوت ولكل سيرفر؛ لا توجد قائمة تشغيل مشتركة.
      sessions: new Map(),
      readyPromise: null,
    };
    bots.push(bot);
    attachBot(bot);
  }

  const results = await Promise.allSettled(
    bots.map(async (bot, index) => {
      await bot.client.login(tokens[index]);
      return bot;
    }),
  );

  const failed = results.filter((result) => result.status === 'rejected');
  failed.forEach((result) => console.error(`تعذر تسجيل دخول أحد البوتات: ${result.reason?.message || result.reason}`));

  const successfulBots = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);

  if (!successfulBots.length) {
    console.error('كل التوكنات فشلت. راجع التوكنات في Environment.');
    process.exitCode = 1;
    return;
  }

  // انتظر جاهزية البوتات، ثم سجّل أوامر Slash على كل تطبيق بوت.
  await Promise.all(successfulBots.map((bot) => bot.readyPromise));
  await Promise.all(successfulBots.map(async (bot) => {
    try {
      await registerSlashCommands(bot);
    } catch (error) {
      log(bot, `تعذر تسجيل أوامر Slash: ${error.message}`);
    }
  }));
  await autoJoinConfiguredRoom();
}

async function shutdown(signal) {
  console.log(`\nوصل ${signal}، جاري إغلاق البوتات...`);
  for (const bot of bots) {
    for (const state of [...bot.sessions.values()]) {
      await closeSession(state, 'تم إغلاق البوت.').catch(() => null);
    }
    bot.client.destroy();
  }
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

void main();
