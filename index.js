
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

// ═══════════════════════════════════════
// إعدادات البوت
// ═══════════════════════════════════════

// حط ID الروم الصوتي هنا
const VOICE_CHANNEL_ID = '1567744232935137350';

const MAX_QUEUE = Math.max(1, Number(process.env.MAX_QUEUE || 50));
const YTDLP_PATH = process.env.YTDLP_PATH ||
  (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const YTDLP_TIMEOUT_MS = 90000;
const READY_TIMEOUT_MS = 30000;

// ═══════════════════════════════════════
// أوامر Slash
// ═══════════════════════════════════════

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('يدخل أول بوت متاح للروم المحدد'),

  new SlashCommandBuilder()
    .setName('song')
    .setDescription('تشغيل أغنية أو إضافتها للقائمة')
    .addStringOption(option =>
      option
        .setName('url')
        .setDescription('رابط الأغنية')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('إيقاف الموسيقى وإخراج البوت'),
].map(command => command.toJSON());

// ═══════════════════════════════════════
// قراءة التوكنات
// ═══════════════════════════════════════

function readTokens() {
  const envKeys = [
    'TOKENS',
    'DISCORD_TOKENS',
    'BOT_TOKENS',
    'DISCORD_TOKEN',
    'DISCORD_BOT_TOKEN',
    'BOT_TOKEN',
    'TOKEN',
  ];

  const envKey = envKeys.find(
    key => typeof process.env[key] === 'string' &&
      process.env[key].trim()
  );

  let rows = [];

  if (envKey) {
    rows = process.env[envKey].split(/[\r\n,;]+/g);
    console.log(`[Config] قراءة التوكنات من ${envKey}`);
  } else {
    const tokenFile = path.join(__dirname, 'tokens.txt');

    if (!fs.existsSync(tokenFile)) {
      throw new Error(
        'ما حصلت التوكنات. أضف TOKENS في Environment أو أنشئ tokens.txt.'
      );
    }

    rows = fs.readFileSync(tokenFile, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/g);
  }

  const tokens = [...new Set(
    rows.map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
  )];

  if (!tokens.length) {
    throw new Error('قائمة التوكنات فارغة.');
  }

  return tokens;
}

// ═══════════════════════════════════════
// بيانات البوتات
// ═══════════════════════════════════════

const bots = [];
const startLocks = new Set();

function log(bot, message) {
  const name = bot?.client?.user?.tag || bot?.label || 'MusicBot';
  console.log(`[${name}] ${message}`);
}

function clip(value, max = 180) {
  const text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();

  return text.length > max
    ? `${text.slice(0, max - 1)}…`
    : text;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'غير معروف';
  }

  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname.slice(0, 32)}`;
  } catch {
    return clip(value, 70);
  }
}

function trackName(track) {
  return clip(
    track?.title || shortUrl(track?.inputUrl || ''),
    180
  ) || 'مقطع بدون اسم';
}

// ═══════════════════════════════════════
// لوحة الموسيقى
// ═══════════════════════════════════════

function makePanelEmbed(state) {
  const paused =
    state.player.state.status === AudioPlayerStatus.Paused;

  const playing =
    state.player.state.status === AudioPlayerStatus.Playing;

  const current = state.currentTrack;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎵 مشغل الموسيقى')
    .setDescription(
      current
        ? `**الحين:** ${trackName(current)}`
        : state.loading
          ? '**جاري تجهيز المقطع...**'
          : '**ما فيه مقطع شغال حالياً**'
    )
    .addFields(
      {
        name: 'الحالة',
        value: paused
          ? '⏸️ متوقف مؤقتاً'
          : playing
            ? '▶️ شغال'
            : state.loading
              ? '⏳ جاري التحميل'
              : '⏹️ متوقف',
        inline: true,
      },
      {
        name: 'المدة',
        value: current?.duration
          ? formatDuration(current.duration)
          : '—',
        inline: true,
      },
      {
        name: 'القائمة',
        value: `${state.queue.length} مقطع`,
        inline: true,
      }
    )
    .setFooter({
      text: `البوت: ${state.bot.client.user.username}`,
    });

  if (current?.webpageUrl) {
    try {
      const url = new URL(current.webpageUrl);
      if (['http:', 'https:'].includes(url.protocol)) {
        embed.setURL(url.toString());
      }
    } catch {}
  }

  if (state.queue[0]) {
    embed.addFields({
      name: 'التالي',
      value: trackName(state.queue[0]),
    });
  }

  return embed;
}

function makePanelComponents(state) {
  const paused =
    state.player.state.status === AudioPlayerStatus.Paused;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:prev`)
      .setLabel('السابقة')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.history.length === 0),

    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:pause`)
      .setLabel(paused ? 'تشغيل' : 'إيقاف مؤقت')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!state.currentTrack || state.loading),

    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:next`)
      .setLabel('التالية')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state.currentTrack && state.queue.length === 0),

    new ButtonBuilder()
      .setCustomId(`music:${state.bot.client.user.id}:${state.guildId}:list`)
      .setLabel('Playlist')
      .setEmoji('📃')
      .setStyle(ButtonStyle.Success)
  );

  return [row];
}

async function updatePanel(state) {
  if (state.closing || !state.panelChannelId) return;

  state.panelUpdate = (state.panelUpdate || Promise.resolve())
    .then(async () => {
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

      const channel = await state.bot.client.channels
        .fetch(state.panelChannelId)
        .catch(() => null);

      if (!channel?.isTextBased() || !channel.send) return;

      state.panelMessage = await channel.send(payload)
        .catch(error => {
          log(state.bot, `تعذر إرسال اللوحة: ${error.message}`);
          return null;
        });
    })
    .catch(error => log(state.bot, error.message));

  return state.panelUpdate;
}

// ═══════════════════════════════════════
// استخراج رابط الصوت بواسطة yt-dlp
// ═══════════════════════════════════════

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
    let timer;

    const finish = (error, data) => {
      if (settled) return;

      settled = true;
      if (timer) clearTimeout(timer);

      if (error) reject(error);
      else resolve(data);
    };

    let child;

    try {
      child = spawn(YTDLP_PATH, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(new Error(`تعذر تشغيل yt-dlp: ${error.message}`));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      stdout += chunk;

      if (stdout.length > 15 * 1024 * 1024) {
        child.kill();
        finish(new Error('بيانات الرابط أكبر من المتوقع.'));
      }
    });

    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-7000);
    });

    child.once('error', error => {
      finish(new Error(
        `ما قدرت أشغل yt-dlp. تأكد من تثبيته: ${error.message}`
      ));
    });

    child.once('close', code => {
      if (settled) return;

      if (code !== 0) {
        if (/DRM protected|cbc-encrypted-hls|ctr-encrypted-hls/i.test(stderr)) {
          finish(new Error(
            'المقطع محمي بـ DRM ولا يدعم yt-dlp استخراج صوته. جرّب رابطاً آخر غير محمي.'
          ));
          return;
        }

        finish(new Error(
          `yt-dlp ما قدر يستخرج الرابط: ${clip(stderr || `exit code ${code}`, 700)}`
        ));
        return;
      }

      try {
        const info = JSON.parse(stdout.trim());

        if (!info.url) {
          throw new Error('المصدر ما رجّع رابط بث مباشر.');
        }

        finish(null, info);
      } catch (error) {
        finish(new Error(
          `تعذر قراءة نتيجة yt-dlp: ${error.message}`
        ));
      }
    });

    timer = setTimeout(() => {
      child.kill();
      finish(new Error(
        'انتهت مهلة استخراج الرابط. حدّث yt-dlp أو جرّب رابطاً آخر.'
      ));
    }, YTDLP_TIMEOUT_MS);

    timer.unref?.();
  });
}

// ═══════════════════════════════════════
// FFmpeg: تحويل الصوت إلى PCM
// ═══════════════════════════════════════

function makeFfmpegArgs(info) {
  const headers = info.http_headers &&
    typeof info.http_headers === 'object'
      ? Object.entries(info.http_headers)
          .map(([key, value]) =>
            `${key}: ${String(value).replace(/[\r\n]/g, '')}\r\n`
          )
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

  if (headers) {
    args.push('-headers', headers);
  }

  args.push(
    '-i', info.url,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1'
  );

  return args;
}

function cleanupFfmpeg(state) {
  const proc = state.ffmpeg;
  state.ffmpeg = null;

  if (proc && proc.exitCode === null && !proc.killed) {
    try {
      proc.kill();
    } catch {}
  }
}

async function sendToPanelChannel(state, content) {
  if (!state.panelChannelId) return;

  const channel = await state.bot.client.channels
    .fetch(state.panelChannelId)
    .catch(() => null);

  if (channel?.isTextBased() && channel.send) {
    await channel.send({
      content: clip(content, 1900),
      allowedMentions: { parse: [] },
    }).catch(error => log(state.bot, error.message));
  }
}

// ═══════════════════════════════════════
// تشغيل الأغاني
// ═══════════════════════════════════════

async function playNext(state) {
  if (
    state.closing ||
    state.loading ||
    state.currentTrack ||
    !state.queue.length
  ) {
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

    const ffmpeg = spawn(
      FFMPEG_PATH,
      makeFfmpegArgs(info),
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    state.ffmpeg = ffmpeg;

    let ffmpegError = '';

    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', chunk => {
      ffmpegError = (ffmpegError + chunk).slice(-4000);
    });

    ffmpeg.once('error', async error => {
      if (state.closing || generation !== state.generation) return;

      state.ffmpeg = null;

      await sendToPanelChannel(
        state,
        `تعذر تشغيل FFmpeg: ${error.message}`
      );

      if (state.player.state.status !== AudioPlayerStatus.Idle) {
        state.suppressHistoryOnce = true;
        state.player.stop(true);
      } else {
        state.currentTrack = null;
        state.loading = false;
        state.generation++;
        void playNext(state);
      }
    });

    ffmpeg.once('close', code => {
      if (state.ffmpeg === ffmpeg) {
        state.ffmpeg = null;
      }

      if (
        code &&
        code !== 0 &&
        !state.closing &&
        generation === state.generation &&
        ffmpegError
      ) {
        log(state.bot, `FFmpeg: ${clip(ffmpegError, 500)}`);
      }
    });

    if (state.closing || generation !== state.generation) {
      try {
        ffmpeg.kill();
      } catch {}
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
    state.generation++;

    await sendToPanelChannel(
      state,
      `ما قدرت أشغّل المقطع: ${clip(error.message, 900)}`
    );

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

    if (state.history.length > 30) {
      state.history.shift();
    }
  }

  state.suppressHistoryOnce = false;

  void updatePanel(state);
  void playNext(state);
}

// ═══════════════════════════════════════
// إنشاء جلسة مستقلة لكل بوت
// ═══════════════════════════════════════

function createSession(bot, guild, voiceChannel, textChannelId) {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
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

  player.on(AudioPlayerStatus.Idle, () => {
    handlePlayerIdle(state);
  });

  player.on('error', error => {
    log(bot, `خطأ بالمشغل: ${error.message}`);

    if (
      !state.closing &&
      state.player.state.status !== AudioPlayerStatus.Idle
    ) {
      state.player.stop(true);
    }
  });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,

    // مهم: مجموعة صوتية منفصلة لكل بوت ولكل سيرفر
    group: `${bot.client.user.id}:${guild.id}`,
  });

  state.connection = connection;

  connection.subscribe(player);

  connection.on('error', error => {
    log(bot, `خطأ اتصال الصوت: ${error.message}`);
  });

  return state;
}

// ═══════════════════════════════════════
// إغلاق الجلسة
// ═══════════════════════════════════════

async function closeSession(state, reason = 'تم إيقاف التشغيل') {
  if (!state || state.closing) return;

  state.closing = true;
  state.generation++;

  cleanupFfmpeg(state);

  try {
    state.player.stop(true);
  } catch {}

  try {
    state.connection?.destroy();
  } catch {}

  state.bot.sessions.delete(state.guildId);

  if (state.panelMessage) {
    const stopped = new EmbedBuilder()
      .setColor(0x747F8D)
      .setTitle('⏹️ تم إيقاف مشغل الموسيقى')
      .setDescription(reason);

    await state.panelMessage.edit({
      embeds: [stopped],
      components: [],
    }).catch(() => null);
  }
}

// ═══════════════════════════════════════
// البحث عن بوت موجود في الروم
// ═══════════════════════════════════════

function findSession(guildId, voiceChannelId) {
  return bots
    .map(bot => bot.sessions.get(guildId))
    .find(state =>
      state &&
      !state.closing &&
      state.channelId === voiceChannelId
    ) || null;
}

// ═══════════════════════════════════════
// إدخال أول بوت متاح للروم
// ═══════════════════════════════════════

async function startConfiguredBot(guildId, textChannelId) {
  if (!/^\d{17,20}$/.test(String(VOICE_CHANNEL_ID || ''))) {
    return {
      error: 'حط ID الروم الصحيح داخل index.js عند VOICE_CHANNEL_ID.',
    };
  }

  const existing = findSession(guildId, VOICE_CHANNEL_ID);

  if (existing) {
    return {
      state: existing,
      already: true,
    };
  }

  let lastReason = 'ما فيه بوت جاهز ومضاف للسيرفر.';
  let hadAvailableBot = false;

  for (const bot of bots) {
    if (!bot.ready || bot.sessions.has(guildId)) continue;

    hadAvailableBot = true;

    const guild =
      bot.client.guilds.cache.get(guildId) ||
      await bot.client.guilds.fetch(guildId).catch(error => {
        lastReason =
          `البوت ${bot.client.user?.username} غير موجود بالسيرفر: ${error.message}`;
        return null;
      });

    if (!guild) continue;

    const voiceChannel = await guild.channels
      .fetch(VOICE_CHANNEL_ID)
      .catch(error => {
        lastReason = `تعذر جلب الروم: ${error.message}`;
        return null;
      });

    if (!voiceChannel) continue;

    if (voiceChannel.type !== ChannelType.GuildVoice) {
      lastReason = 'ID المحدد ليس لروم صوتي عادي.';
      continue;
    }

    const permissions = voiceChannel.permissionsFor(bot.client.user);

    if (!permissions?.has([
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak,
    ])) {
      lastReason =
        `أعطِ ${bot.client.user.username} صلاحيتَي Connect و Speak.`;
      continue;
    }

    let state;

    try {
      state = createSession(
        bot,
        guild,
        voiceChannel,
        textChannelId
      );

      bot.sessions.set(guildId, state);

      await entersState(
        state.connection,
        VoiceConnectionStatus.Ready,
        READY_TIMEOUT_MS
      );

      log(bot, `دخل الروم: ${voiceChannel.name}`);

      return {
        state,
        already: false,
      };

    } catch (error) {
      lastReason =
        `فشل اتصال ${bot.client.user.username}: ${error.message}`;

      if (state) {
        await closeSession(
          state,
          'تعذر الاتصال بالروم الصوتي.'
        ).catch(() => null);
      }

      log(bot, lastReason);
    }
  }

  if (
    !hadAvailableBot &&
    bots.some(bot => bot.sessions.has(guildId))
  ) {
    lastReason =
      'كل البوتات مشغولة في هذا السيرفر.';
  }

  return { error: lastReason };
}

// ═══════════════════════════════════════
// الردود الخاصة بالأوامر
// ═══════════════════════════════════════

async function deferPrivate(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function replyPrivate(interaction, content) {
  const payload = {
    content,
    allowedMentions: { parse: [] },
  };

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }

  return interaction.reply({
    ...payload,
    flags: MessageFlags.Ephemeral,
  });
}

async function getInteractionVoiceChannelId(interaction) {
  if (!interaction.guild) return null;

  const cached = interaction.guild.voiceStates.cache
    .get(interaction.user.id)?.channelId;

  if (cached) return cached;

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  return member?.voice?.channelId || null;
}

// ═══════════════════════════════════════
// أمر /start
// ═══════════════════════════════════════

async function handleStart(interaction) {
  await deferPrivate(interaction);

  if (!interaction.guild) {
    await replyPrivate(interaction, 'الأمر داخل السيرفر فقط.');
    return;
  }

  if (startLocks.has(interaction.guildId)) {
    await replyPrivate(interaction, 'جاري إدخال البوت، جرّب بعد لحظة.');
    return;
  }

  startLocks.add(interaction.guildId);

  try {
    const result = await startConfiguredBot(
      interaction.guildId,
      interaction.channelId
    );

    if (result.error) {
      await replyPrivate(
        interaction,
        `ما قدرت أدخل البوت: ${clip(result.error, 700)}`
      );
      return;
    }

    if (result.already) {
      await replyPrivate(
        interaction,
        `البوت ${result.state.bot.client.user.username} موجود أصلاً بالروم.`
      );
      return;
    }

    await replyPrivate(
      interaction,
      `دخل ${result.state.bot.client.user.username} للروم بنجاح.`
    );

  } finally {
    startLocks.delete(interaction.guildId);
  }
}

// ═══════════════════════════════════════
// أمر /song
// يدخل البوت تلقائياً إذا لم يكن متصلاً
// ═══════════════════════════════════════

async function handleSong(interaction, rawUrl) {
  await deferPrivate(interaction);

  if (!interaction.guild) {
    await replyPrivate(interaction, 'الأمر داخل السيرفر فقط.');
    return;
  }

  const voiceChannelId =
    await getInteractionVoiceChannelId(interaction);

  if (!voiceChannelId) {
    await replyPrivate(
      interaction,
      'ادخل الروم الصوتي أولاً ثم استخدم /song.'
    );
    return;
  }

  if (voiceChannelId !== VOICE_CHANNEL_ID) {
    await replyPrivate(
      interaction,
      `البوت مضبوط على الروم <#${VOICE_CHANNEL_ID}>. ادخل هذا الروم أولاً.`
    );
    return;
  }

  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = null;
  }

  if (
    !parsed ||
    !['http:', 'https:'].includes(parsed.protocol)
  ) {
    await replyPrivate(
      interaction,
      'حط رابط صحيح يبدأ بـ http أو https.'
    );
    return;
  }

  let state = findSession(
    interaction.guildId,
    VOICE_CHANNEL_ID
  );

  // إذا ما فيه بوت متصل، يدخل أول بوت متاح تلقائياً
  if (!state) {
    if (startLocks.has(interaction.guildId)) {
      await replyPrivate(
        interaction,
        'جاري إدخال البوت للروم، أعد /song بعد لحظة.'
      );
      return;
    }

    startLocks.add(interaction.guildId);

    try {
      const result = await startConfiguredBot(
        interaction.guildId,
        interaction.channelId
      );

      if (result.error) {
        await replyPrivate(
          interaction,
          `ما قدرت أدخل البوت: ${clip(result.error, 700)}`
        );
        return;
      }

      state = result.state;

    } finally {
      startLocks.delete(interaction.guildId);
    }
  }

  if (
    state.queue.length +
    (state.currentTrack ? 1 : 0) >= MAX_QUEUE
  ) {
    await replyPrivate(
      interaction,
      `القائمة ممتلئة. الحد الأعلى ${MAX_QUEUE} مقطع.`
    );
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

  if (
    !state.panelMessage &&
    !state.loading &&
    !state.currentTrack
  ) {
    state.panelChannelId = interaction.channelId;
  }

  await replyPrivate(interaction, 'تمت إضافة المقطع للقائمة 🎶');

  await updatePanel(state);

  if (
    !state.loading &&
    !state.currentTrack &&
    state.player.state.status === AudioPlayerStatus.Idle
  ) {
    void playNext(state);
  }
}

// ═══════════════════════════════════════
// أمر /stop
// ═══════════════════════════════════════

async function handleStop(interaction) {
  await deferPrivate(interaction);

  if (!interaction.guild) {
    await replyPrivate(interaction, 'الأمر داخل السيرفر فقط.');
    return;
  }

  const voiceChannelId =
    await getInteractionVoiceChannelId(interaction);

  if (!voiceChannelId) {
    await replyPrivate(
      interaction,
      'ادخل الروم الصوتي اللي فيه البوت أولاً.'
    );
    return;
  }

  const state = findSession(
    interaction.guildId,
    voiceChannelId
  );

  if (!state) {
    await replyPrivate(
      interaction,
      'ما فيه بوت شغال في رومك الصوتي.'
    );
    return;
  }

  await replyPrivate(
    interaction,
    `تم إيقاف ${state.bot.client.user.username} وإخراجه من الروم.`
  );

  await closeSession(
    state,
    'تم إيقاف الأغنية وخرج البوت من الروم.'
  );
}

// ═══════════════════════════════════════
// معالجة أوامر Slash
// ═══════════════════════════════════════

async function handleSlashCommand(bot, interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'start') {
    return handleStart(interaction);
  }

  if (interaction.commandName === 'song') {
    return handleSong(
      interaction,
      interaction.options.getString('url', true)
    );
  }

  if (interaction.commandName === 'stop') {
    return handleStop(interaction);
  }
}

async function registerSlashCommands(bot) {
  await bot.client.application.commands.set(SLASH_COMMANDS);

  log(bot, 'تم تسجيل أوامر Slash.');
}

// ═══════════════════════════════════════
// دخول تلقائي عند تشغيل البرنامج
// ═══════════════════════════════════════

async function autoJoinConfiguredRoom() {
  if (!/^\d{17,20}$/.test(VOICE_CHANNEL_ID)) {
    console.error(
      '[Config] حط ID الروم الصحيح في VOICE_CHANNEL_ID.'
    );
    return;
  }

  let lastReason = 'ما لقيت بوت جاهز ومضاف للسيرفر.';

  for (const bot of bots) {
    if (!bot.ready) continue;

    const voiceChannel = await bot.client.channels
      .fetch(VOICE_CHANNEL_ID)
      .catch(error => {
        lastReason = error.message;
        return null;
      });

    if (!voiceChannel) continue;

    if (voiceChannel.type !== ChannelType.GuildVoice) {
      lastReason = 'ID المحدد ليس لروم صوتي عادي.';
      continue;
    }

    const guild = voiceChannel.guild;

    if (
      bots.some(candidate =>
        candidate.sessions.has(guild.id)
      )
    ) {
      return;
    }

    const permissions = voiceChannel.permissionsFor(
      bot.client.user
    );

    if (!permissions?.has([
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak,
    ])) {
      lastReason =
        `${bot.client.user.tag} لا يملك Connect و Speak.`;
      continue;
    }

    if (startLocks.has(guild.id)) continue;

    startLocks.add(guild.id);

    let state;

    try {
      state = createSession(
        bot,
        guild,
        voiceChannel,
        null
      );

      bot.sessions.set(guild.id, state);

      await entersState(
        state.connection,
        VoiceConnectionStatus.Ready,
        READY_TIMEOUT_MS
      );

      log(bot, `دخل تلقائياً الروم ${voiceChannel.name}`);

      return;

    } catch (error) {
      lastReason = error.message;

      if (state) {
        await closeSession(
          state,
          'تعذر الاتصال بالروم.'
        ).catch(() => null);
      }

      log(bot, `فشل الدخول التلقائي: ${error.message}`);

    } finally {
      startLocks.delete(guild.id);
    }
  }

  console.error(
    `[Voice] ما قدرت أدخل الروم: ${lastReason}`
  );
}

// ═══════════════════════════════════════
// قائمة التشغيل Playlist
// ═══════════════════════════════════════

function makePlaylistEmbed(state) {
  const lines = [];

  if (state.currentTrack) {
    lines.push(`**الحين:** ${trackName(state.currentTrack)}`);
  } else if (state.loading) {
    lines.push('**الحين:** جاري التجهيز...');
  } else {
    lines.push('**الحين:** ما فيه شيء شغال');
  }

  if (state.queue.length) {
    lines.push('', '**القائمة:**');

    state.queue.slice(0, 25).forEach((track, index) => {
      lines.push(`${index + 1}. ${trackName(track)}`);
    });

    if (state.queue.length > 25) {
      lines.push(`و ${state.queue.length - 25} مقطع إضافي`);
    }
  } else {
    lines.push('', 'القائمة فاضية.');
  }

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('📃 قائمة التشغيل')
    .setDescription(lines.join('\n').slice(0, 4000));
}

// ═══════════════════════════════════════
// أزرار التحكم
// ═══════════════════════════════════════

async function handleButton(bot, interaction) {
  if (
    !interaction.isButton() ||
    !interaction.customId.startsWith('music:')
  ) return;

  const [, botId, guildId, action] =
    interaction.customId.split(':');

  if (
    !botId ||
    !guildId ||
    !action ||
    botId !== bot.client.user.id
  ) return;

  const state = bot.sessions.get(guildId);

  if (!state || state.closing) {
    await interaction.reply({
      content: 'جلسة الموسيقى انتهت.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
    return;
  }

  const member = await interaction.guild?.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (
    !member ||
    member.voice.channelId !== state.channelId
  ) {
    await interaction.reply({
      content: 'لازم تكون في نفس الروم الصوتي للتحكم.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
    return;
  }

  // عرض القائمة
  if (action === 'list') {
    await interaction.reply({
      embeds: [makePlaylistEmbed(state)],
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
    return;
  }

  // إيقاف مؤقت / تشغيل
  if (action === 'pause') {
    if (
      state.player.state.status === AudioPlayerStatus.Paused
    ) {
      state.player.unpause();

    } else if (
      state.player.state.status === AudioPlayerStatus.Playing
    ) {
      state.player.pause();

    } else {
      await interaction.reply({
        content: 'ما فيه مقطع جاهز للتحكم فيه.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return;
    }

    await interaction.deferUpdate().catch(() => null);
    await updatePanel(state);
    return;
  }

  // التالية
  if (action === 'next') {
    if (!state.currentTrack && !state.loading) {
      await interaction.reply({
        content: 'ما فيه مقطع حالي.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return;
    }

    await interaction.deferUpdate().catch(() => null);

    if (
      state.loading &&
      state.player.state.status === AudioPlayerStatus.Idle
    ) {
      state.generation++;
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

  // السابقة
  if (action === 'prev') {
    const previous = state.history.pop();

    if (!previous) {
      await interaction.reply({
        content: 'ما فيه مقطع سابق.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return;
    }

    const current = state.currentTrack;

    if (current) {
      state.queue.unshift(current);
    }

    state.queue.unshift(previous);

    await interaction.deferUpdate().catch(() => null);

    if (
      state.loading &&
      state.player.state.status === AudioPlayerStatus.Idle
    ) {
      state.generation++;
      state.currentTrack = null;
      state.loading = false;

      cleanupFfmpeg(state);
      void playNext(state);

    } else if (
      state.player.state.status === AudioPlayerStatus.Idle
    ) {
      void playNext(state);

    } else {
      state.suppressHistoryOnce = true;
      state.player.stop(true);
    }

    await updatePanel(state);
  }
}

// ═══════════════════════════════════════
// ربط الأحداث لكل بوت
// ═══════════════════════════════════════

function attachBot(bot) {
  bot.readyPromise = new Promise(resolve => {
    bot.client.once(Events.ClientReady, client => {
      bot.ready = true;
      log(bot, `جاهز: ${client.user.tag}`);
      resolve(client);
    });
  });

  bot.client.on(Events.InteractionCreate, interaction => {
    const task = interaction.isButton()
      ? handleButton(bot, interaction)
      : handleSlashCommand(bot, interaction);

    void task.catch(async error => {
      log(bot, `خطأ بالتفاعل: ${error.stack || error.message}`);

      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction.reply({
          content: 'صار خطأ أثناء تنفيذ الأمر.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => null);

      } else if (
        interaction.isRepliable() &&
        interaction.deferred
      ) {
        await interaction.editReply({
          content: 'صار خطأ أثناء تنفيذ الأمر.',
        }).catch(() => null);
      }
    });
  });

  bot.client.on('error', error => {
    log(bot, `Discord error: ${error.message}`);
  });
}

// ═══════════════════════════════════════
// تشغيل جميع البوتات
// ═══════════════════════════════════════

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

  for (let index = 0; index < tokens.length; index++) {
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

      // حالة منفصلة لكل بوت ولكل سيرفر
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
    })
  );

  const failed = results.filter(
    result => result.status === 'rejected'
  );

  failed.forEach(result => {
    console.error(
      `فشل تسجيل دخول بوت: ${result.reason?.message || result.reason}`
    );
  });

  const successfulBots = results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);

  if (!successfulBots.length) {
    console.error('كل التوكنات فشلت. راجع TOKENS.');
    process.exitCode = 1;
    return;
  }

  await Promise.all(
    successfulBots.map(bot => bot.readyPromise)
  );

  // تسجيل أوامر Slash لكل بوت
  await Promise.all(
    successfulBots.map(async bot => {
      try {
        await registerSlashCommands(bot);
      } catch (error) {
        log(bot, `تعذر تسجيل الأوامر: ${error.message}`);
      }
    })
  );

  // دخول الروم تلقائياً
  await autoJoinConfiguredRoom();
}

// ═══════════════════════════════════════
// إغلاق البرنامج
// ═══════════════════════════════════════

async function shutdown(signal) {
  console.log(`إغلاق البوتات بسبب ${signal}`);

  for (const bot of bots) {
    for (const state of [...bot.sessions.values()]) {
      await closeSession(state, 'تم إغلاق البوت.');
    }

    bot.client.destroy();
  }

  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

void main();
