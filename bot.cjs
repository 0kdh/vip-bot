const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});

const sayIntervals = new Map();
// key: channelId
// value: { intervalId, channels:Set, text }

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : IMPORTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  Collection,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

dotenv.config();

// Validate required environment variables
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);

if (!TOKEN) {
  console.error('❌ Missing TOKEN in .env file!');
  process.exit(1);
}

// ─── Discord Client ──────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Startup time for uptime calculation
const startTime = Date.now();

// In-memory map for OAuth2 state tokens: state → { userId, guildId, authButtonId, expires }
const oauthStates = new Map();

// In-memory map for poll votes: messageId → { userId: optionIndex }
const pollVotes = new Map();

// In-memory confirmation map: userId → { resolve, reject, timeout }
const confirmations = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : BASE DE DONNÉES SQLITE
// ═══════════════════════════════════════════════════════════════════════════════

const db = require('better-sqlite3')(path.join(__dirname, 'data', 'data.sqlite'));

// AJOUTE CELA :
console.log('DB Path:', require('path').resolve('./data/data.sqlite'));
console.log('DB Exists:', require('fs').existsSync('./data/data.sqlite'));

// Test d'écriture
try {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run('test', 'value');
    console.log('DB Write: OK');
} catch (e) {
    console.error('DB Write ERROR:', e.message);
}

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Initialize all database tables
 */
function initDatabase() {
  db.exec(`
    -- Global server configuration
    CREATE TABLE IF NOT EXISTS config (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (guild_id, key)
    );

    -- Custom embeds
    CREATE TABLE IF NOT EXISTS embeds (
      guild_id TEXT NOT NULL,
      embed_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (guild_id, embed_id)
    );

    -- Announcements
    CREATE TABLE IF NOT EXISTS announces (
      guild_id TEXT NOT NULL,
      announce_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (guild_id, announce_id)
    );

    -- Buttons
    CREATE TABLE IF NOT EXISTS buttons (
      guild_id TEXT NOT NULL,
      button_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (guild_id, button_id)
    );

    -- Ticket instances
    CREATE TABLE IF NOT EXISTS tickets (
      guild_id TEXT NOT NULL,
      ticket_channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (guild_id, ticket_channel_id)
    );

    -- Ticket system configuration
    CREATE TABLE IF NOT EXISTS ticket_config (
      guild_id TEXT PRIMARY KEY,
      category_id TEXT,
      log_channel_id TEXT,
      support_role_id TEXT,
      panel_message_id TEXT
    );

    -- Access system
    CREATE TABLE IF NOT EXISTS access (
      guild_id TEXT NOT NULL,
      access_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (guild_id, access_id)
    );

    -- Moderation warnings
    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT,
      timestamp INTEGER DEFAULT (strftime('%s','now'))
    );

    -- Mutes
    CREATE TABLE IF NOT EXISTS mutes (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER,
      reason TEXT,
      PRIMARY KEY (guild_id, user_id)
    );

    -- Reaction roles
    CREATE TABLE IF NOT EXISTS reaction_roles (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, message_id, emoji)
    );

    -- Custom commands
    CREATE TABLE IF NOT EXISTS custom_commands (
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      response TEXT,
      embed_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (guild_id, name)
    );

    -- Polls
    CREATE TABLE IF NOT EXISTS polls (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      type TEXT DEFAULT 'yesno',
      ended INTEGER DEFAULT 0,
      channel_id TEXT,
      PRIMARY KEY (guild_id, message_id)
    );

    -- Poll votes (to prevent duplicates)
    CREATE TABLE IF NOT EXISTS poll_votes (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      PRIMARY KEY (guild_id, message_id, user_id)
    );

    -- Auth buttons (OAuth2)
    CREATE TABLE IF NOT EXISTS auth_buttons (
      guild_id TEXT NOT NULL,
      button_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (guild_id, button_id)
    );
  `);

  console.log('✅ Database initialized successfully.');
}

initDatabase();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : UTILITAIRES & HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Config Helpers ──────────────────────────────────────────────────────────

/**
 * Get a configuration value for a guild
 * @param {string} guildId
 * @param {string} key
 * @param {*} defaultValue
 * @returns {string|*}
 */
function getConfig(guildId, key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM config WHERE guild_id = ? AND key = ?').get(guildId, key);
  return row ? row.value : defaultValue;
}

/**
 * Set a configuration value for a guild
 * @param {string} guildId
 * @param {string} key
 * @param {string} value
 */
function setConfig(guildId, key, value) {
  db.prepare('INSERT OR REPLACE INTO config (guild_id, key, value) VALUES (?, ?, ?)').run(guildId, key, value);
}

/**
 * Get the bot prefix for a guild
 * @param {string} guildId
 * @returns {string}
 */
function getPrefix(guildId) {
  return getConfig(guildId, 'prefix', '!');
}

/**
 * Get the default embed color for a guild
 * @param {string} guildId
 * @returns {string}
 */
function getDefaultColor(guildId) {
  return getConfig(guildId, 'default_embed_color', '#D1AA0B');
}

/**
 * Check if a member has admin permissions
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isAdmin(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const adminRolesRaw = getConfig(member.guild.id, 'admin_roles', '[]');
  let adminRoles = [];
  try { adminRoles = JSON.parse(adminRolesRaw); } catch {}
  return adminRoles.some(rid => member.roles.cache.has(rid));
}

/**
 * Check if a member has moderator permissions
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isMod(member) {
  if (isAdmin(member)) return true;
  const modRolesRaw = getConfig(member.guild.id, 'mod_roles', '[]');
  let modRoles = [];
  try { modRoles = JSON.parse(modRolesRaw); } catch {}
  return modRoles.some(rid => member.roles.cache.has(rid));
}

// ─── Embed Helpers ───────────────────────────────────────────────────────────

/**
 * Create a standard success embed
 */
function successEmbed(guildId, title, description) {
  return new EmbedBuilder()
    .setColor(getDefaultColor(guildId))
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Create a standard error embed
 */
function errorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Create a standard info embed
 */
function infoEmbed(guildId, title, description) {
  return new EmbedBuilder()
    .setColor(getDefaultColor(guildId))
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Build a Discord embed from stored JSON data
 * @param {object} data
 * @param {string} guildId
 * @returns {EmbedBuilder}
 */
function buildEmbed(data, guildId) {
  const embed = new EmbedBuilder();
  embed.setColor(data.color || getDefaultColor(guildId));
  if (data.title) embed.setTitle(data.title);
  if (data.description) embed.setDescription(data.description.replace(/\\n/g, '\n'));
  if (data.image) embed.setImage(data.image);
  if (data.thumbnail) embed.setThumbnail(data.thumbnail);
  if (data.url) embed.setURL(data.url);
  if (data.timestamp) embed.setTimestamp();
  if (data.footer) {
    const footerOpts = { text: data.footer.text || '\u200b' };
    if (data.footer.iconUrl) footerOpts.iconURL = data.footer.iconUrl;
    embed.setFooter(footerOpts);
  }
  if (data.author && data.author.name) {
    const authorOpts = { name: data.author.name };
    if (data.author.iconUrl) authorOpts.iconURL = data.author.iconUrl;
    if (data.author.url) authorOpts.url = data.author.url;
    embed.setAuthor(authorOpts);
  }
  if (data.fields && Array.isArray(data.fields)) {
    for (const field of data.fields) {
      embed.addFields({ name: field.name, value: field.value, inline: !!field.inline });
    }
  }
  return embed;
}

/**
 * Validate a HEX color string
 * @param {string} hex
 * @returns {boolean}
 */
function isValidHex(hex) {
  return /^#[0-9A-Fa-f]{6}$/.test(hex);
}

/**
 * Validate a URL string
 * @param {string} url
 * @returns {boolean}
 */
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

/**
 * Format duration in milliseconds to human readable string
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const parts = [];
  if (days > 0) parts.push(`${days}j`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}min`);
  if (seconds % 60 > 0) parts.push(`${seconds % 60}s`);
  return parts.join(' ') || '0s';
}

/**
 * Parse duration string to milliseconds
 * Examples: 10m, 1h, 1d, 30s
 * @param {string} str
 * @returns {number|null}
 */
function parseDuration(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * multipliers[unit];
}

/**
 * Replace variables in a message template
 * @param {string} template
 * @param {import('discord.js').GuildMember} member
 * @returns {string}
 */
function replaceVariables(template, member) {
  return template
    .replace(/{user}/g, member.user.username)
    .replace(/{mention}/g, `<@${member.user.id}>`)
    .replace(/{server}/g, member.guild.name)
    .replace(/{count}/g, member.guild.memberCount.toString());
}

/**
 * Send a log message to the configured log channel
 * @param {import('discord.js').Guild} guild
 * @param {EmbedBuilder} embed
 */
async function sendLog(guild, embed) {
  try {
    const logChannelId = getConfig(guild.id, 'log_channel');
    if (!logChannelId) return;
    const channel = guild.channels.cache.get(logChannelId);
    if (!channel) return;
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Error sending log:', err.message);
  }
}

/**
 * Build action rows from button IDs (regular + auth buttons)
 * @param {string} guildId
 * @param {string[]} buttonIds
 * @returns {ActionRowBuilder[]}
 */
function buildActionRows(guildId, buttonIds) {
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let count = 0;

  for (const btnId of buttonIds) {
    // Check regular buttons first
    let btnData = null;
    const regularBtn = db.prepare('SELECT data FROM buttons WHERE guild_id = ? AND button_id = ?').get(guildId, btnId);
    if (regularBtn) {
      try { btnData = JSON.parse(regularBtn.data); } catch {}
    }

    // Check auth buttons
    if (!btnData) {
      const authBtn = db.prepare('SELECT data FROM auth_buttons WHERE guild_id = ? AND button_id = ?').get(guildId, btnId);
      if (authBtn) {
        try {
          const authData = JSON.parse(authBtn.data);
          authData._isAuth = true;
          authData._authId = btnId;
          btnData = authData;
        } catch {}
      }
    }

    if (!btnData) continue;

    const styleMap = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
    const btn = new ButtonBuilder()
      .setCustomId(`btn_${btnId}`)
      .setLabel(btnData.label || 'Button')
      .setStyle(styleMap[btnData.style] || ButtonStyle.Primary)
      .setDisabled(!!btnData.disabled);

    if (btnData.emoji) {
      try { btn.setEmoji(btnData.emoji); } catch {}
    }

    if (count > 0 && count % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(btn);
    count++;

    if (rows.length >= 5) break;
  }

  if (count > 0) rows.push(currentRow);
  return rows;
}

/**
 * Generate a UUID v4
 * @returns {string}
 */
function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/**
 * Paginate an array of items
 * @param {any[]} items
 * @param {number} page 0-indexed
 * @param {number} perPage
 * @returns {{ items: any[], total: number, pages: number }}
 */
function paginate(items, page = 0, perPage = 10) {
  const total = items.length;
  const pages = Math.ceil(total / perPage);
  const start = page * perPage;
  return {
    items: items.slice(start, start + perPage),
    total,
    pages: Math.max(1, pages),
    page,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
async function handleMessage(message) {
  if (message.author.bot) return;
  if (!message.guild) return;

  const prefix = getPrefix(message.guild.id);

  if (!message.content.startsWith(prefix)) {
    await handleCustomCommand(message, prefix);
    return;
  }

  const withoutPrefix = message.content.slice(prefix.length);
  const args = withoutPrefix.trim().split(' ');
  const command = args.shift().toLowerCase();

  const rawContent = withoutPrefix.slice(command.length).trim();

  try {
    switch (command) {

      // ─── COMMANDES SIMPLES ───
      case 'lien':
        await cmdLien(message);
        break;

      case 'pay':
        await cmdPay(message);
        break;

      case 'stats':
        await cmdStats(message);
        break;

      case 'statsconfig':
        await cmdStatsConfig(message, args);
        break;

      // Alias pratiques
      case 'setvipRole'.toLowerCase():
      case 'setvip':
        await cmdStatsConfig(message, ['setvip', ...args]);
        break;

      case 'say':
        await cmdSay(message, args, {
          PREFIX: prefix,
          COLORS: {
            DANGER: '#FF0000'
          }
        });
        break;

      // ─── UTILITAIRES ───
      case 'ping': await cmdPing(message); break;
      case 'uptime': await cmdUptime(message); break;
      case 'botinfo': await cmdBotInfo(message); break;
      case 'serverinfo': await cmdServerInfo(message); break;
      case 'userinfo': await cmdUserInfo(message, args); break;
      case 'avatar': await cmdAvatar(message, args); break;
      case 'help': await cmdHelp(message, args); break;

      // CONFIG
      case 'setprefix': await cmdSetPrefix(message, args); break;
      case 'setlogchannel': await cmdSetLogChannel(message, args); break;
      case 'setadminrole': await cmdSetAdminRole(message, args); break;
      case 'setmodrole': await cmdSetModRole(message, args); break;
      case 'setmuterole': await cmdSetMuteRole(message, args); break;
      case 'autorole': await cmdAutorole(message, args); break;
      case 'setwelcome': await cmdSetWelcome(message, args); break;
      case 'welcometest': await cmdWelcomeTest(message); break;
      case 'setcolor': await cmdSetColor(message, args); break;

      // SYSTEMES
      case 'embed': await cmdEmbed(message, args); break;
      case 'announce': await cmdAnnounce(message, args, withoutPrefix); break;
      case 'button': await cmdButton(message, args); break;
      case 'auth': await cmdAuth(message, args); break;
      case 'ticket': await cmdTicket(message, args); break;
      case 'access': await cmdAccess(message, args); break;

      // MODERATION
      case 'warn': await cmdWarn(message, args); break;
      case 'warnings': await cmdWarnings(message, args); break;
      case 'clearwarns': await cmdClearWarns(message, args); break;
      case 'delwarn': await cmdDelWarn(message, args); break;
      case 'mute': await cmdMute(message, args); break;
      case 'unmute': await cmdUnmute(message, args); break;
      case 'kick': await cmdKick(message, args); break;
      case 'ban': await cmdBan(message, args); break;
      case 'unban': await cmdUnban(message, args); break;
      case 'softban': await cmdSoftBan(message, args); break;
      case 'banlist': await cmdBanList(message); break;
      case 'purge': await cmdPurge(message, args); break;
      case 'slowmode': await cmdSlowmode(message, args); break;
      case 'lock': await cmdLock(message, args); break;
      case 'unlock': await cmdUnlock(message, args); break;

      // ROLES
      case 'role': await cmdRole(message, args); break;
      case 'reactionrole': await cmdReactionRole(message, args); break;

      // CUSTOM
      case 'cc': await cmdCC(message, args); break;

      // POLL
      case 'poll': await cmdPoll(message, args); break;

      default:
        break;
    }

  } catch (err) {
    console.error(`Error handling command "${command}":`, err);
    try {
      await message.reply({
        embeds: [errorEmbed('Erreur interne', `Une erreur est survenue : \`${err.message}\``)]
      });
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : COMMANDES UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════════

/** !ping */
async function cmdPing(message) {
  const start = Date.now();
  const msg = await message.reply({ embeds: [infoEmbed(message.guild.id, 'Ping', '📡 Calcul en cours...')] });
  const apiLatency = Date.now() - start;
  const wsLatency = client.ws.ping;
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle('🏓 Pong!')
    .addFields(
      { name: '📡 Latence API', value: `\`${apiLatency}ms\``, inline: true },
      { name: '💓 WebSocket', value: `\`${wsLatency}ms\``, inline: true }
    )
    .setTimestamp();
  await msg.edit({ embeds: [embed] });
}

/** !uptime */
async function cmdUptime(message) {
  const uptime = Date.now() - startTime;
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle('⏱️ Uptime du bot')
    .setDescription(`Le bot est en ligne depuis **${formatDuration(uptime)}**`)
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

/** !botinfo */
async function cmdBotInfo(message) {
  const memUsage = process.memoryUsage();
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle('🤖 Informations du Bot')
    .setThumbnail(client.user.displayAvatarURL())
    .addFields(
      { name: '📦 discord.js', value: '`v14`', inline: true },
      { name: '🟩 Node.js', value: `\`${process.version}\``, inline: true },
      { name: '💾 Mémoire', value: `\`${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB\``, inline: true },
      { name: '🌐 Serveurs', value: `\`${client.guilds.cache.size}\``, inline: true },
      { name: '👥 Utilisateurs', value: `\`${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0)}\``, inline: true },
      { name: '⏱️ Uptime', value: `\`${formatDuration(Date.now() - startTime)}\``, inline: true }
    )
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

/** !serverinfo */
async function cmdServerInfo(message) {
  const g = message.guild;
  await g.fetch();
  const owner = await g.fetchOwner();
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(g.id))
    .setTitle(`📊 Informations du Serveur — ${g.name}`)
    .setThumbnail(g.iconURL())
    .addFields(
      { name: '🆔 ID', value: `\`${g.id}\``, inline: true },
      { name: '👑 Propriétaire', value: `${owner.user.tag}`, inline: true },
      { name: '👥 Membres', value: `\`${g.memberCount}\``, inline: true },
      { name: '🎭 Rôles', value: `\`${g.roles.cache.size}\``, inline: true },
      { name: '💬 Salons', value: `\`${g.channels.cache.size}\``, inline: true },
      { name: '🚀 Boosts', value: `\`${g.premiumSubscriptionCount || 0}\``, inline: true },
      { name: '📅 Créé le', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:F>`, inline: true },
      { name: '✅ Niveau de vérification', value: `\`${g.verificationLevel}\``, inline: true }
    )
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

/** !userinfo [@user] */
async function cmdUserInfo(message, args) {
  let member = message.mentions.members.first();
  if (!member) member = message.member;
  const user = member.user;
  const roles = member.roles.cache.filter(r => r.id !== message.guild.id).map(r => r.toString()).join(', ') || 'Aucun';
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`👤 Informations — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '🆔 ID', value: `\`${user.id}\``, inline: true },
      { name: '🤖 Bot', value: user.bot ? '`Oui`' : '`Non`', inline: true },
      { name: '📅 Compte créé', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: false },
      { name: '📥 A rejoint le', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`, inline: false },
      { name: `🎭 Rôles (${member.roles.cache.size - 1})`, value: roles.length > 1024 ? roles.substring(0, 1020) + '...' : roles, inline: false }
    )
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

/** !avatar [@user] */
async function cmdAvatar(message, args) {
  let user = message.mentions.users.first();
  if (!user) user = message.author;
  const formats = ['png', 'jpg', 'webp'];
  if (user.avatar && user.avatar.startsWith('a_')) formats.push('gif');
  const links = formats.map(f => `[${f.toUpperCase()}](${user.displayAvatarURL({ extension: f, size: 1024 })})`).join(' • ');
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`🖼️ Avatar — ${user.username}`)
    .setImage(user.displayAvatarURL({ size: 1024 }))
    .setDescription(links)
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

/** !lien */
async function cmdLien(message) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Rejoindre le serveur")
      .setEmoji({ id: "1511885487932051536", name: "golddiscord" })
      .setURL("https://discord.gg/GEhgWcyM")
      .setStyle(ButtonStyle.Link)
  );

  await message.reply({
    content: "**Clique ici pour rejoindre le serveur VIP !**",
    components: [row],
  });
}

/** !pay */
async function cmdPay(message) {
  const embed = new EmbedBuilder()
    .setTitle("💰 Moyens de paiement")
    .setColor('#f1c40f')
    .setDescription("Voici tous les moyens pour soutenir :")
    .addFields(
      { name: "<:paypal:1512243057272291369> PayPal", value: "`paypal.me/tonlien`", inline: false },
      { name: "<:revolut:1512240395164061839> Revolut", value: "`https://revolut.me/ewaaannnnnn`", inline: false },
      { name: "<:stripelogo:1512240424020873288> Carte bancaire", value: "`Stripe / autre`", inline: false },
      { name: "<:bitcoin:1512240466530271313> Bitcoin (BTC)", value: "`bc1q8tvg27e48p7ykj9k5ufn70rh8axq6n52k33jtq`", inline: false },
      { name: "<:ltc:1512240451233648873> Litecoin (LTC)", value: "`LeiLAiHdTzsQgFfUFcVtVKsdBEqrPpyzCQ`", inline: false },
      { name: "<:ethereum:1512240408338497687> Ethereum (ETH)", value: "`0xDC4748F3Aa8B8221B47F93FCE83DaF4eD38c866E`", inline: false },
      { name: "<:monero:1512240520687255702> Monero (XMR)", value: "`45c7LQU4pNS1SXDeTA1nkohJdqHZqhAyR8nQ856GcMPye6fYt5WxDBN6XGckAVKJbv19acNyECvxJVnTRMeSt4WcF7DzUZp`", inline: false }
    )
    .setFooter({ text: "Oublie pas d'envoyer les preuves !" })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// ============================================================
//  SAY — Stockage global des répétitions actives
//  Map : channelId → { interval, currentMsgId }
// ============================================================
if (!global.sayData) global.sayData = new Map();

// ============================================================
//  Listener messageDelete global (enregistré une seule fois)
// ============================================================
function ensureDeleteListener(client) {
  if (global.sayDeleteListenerReady) return;
  global.sayDeleteListenerReady = true;

  client.on('messageDelete', async (deleted) => {
    const entry = global.sayData.get(deleted.channelId);
    if (!entry) return;

    // Ce n'est pas le message du repeat → on ignore
    if (deleted.id !== entry.currentMsgId) return;

    // C'est notre message → on stoppe proprement
    clearInterval(entry.interval);
    global.sayData.delete(deleted.channelId);

    // Notification qui s'auto-supprime après 5s
    try {
      const channel = deleted.channel ?? await client.channels.fetch(deleted.channelId);
      const notif = await channel.send('⏹ Repeat arrêté automatiquement.');
      setTimeout(() => notif.delete().catch(() => {}), 5_000);
    } catch (_) {}
  });
}

// ============================================================
//  Helpers
// ============================================================

async function safeSend(channel, text) {
  try {
    return await channel.send({
      content: text,
      allowedMentions: { parse: ['users', 'roles', 'everyone'] },
    });
  } catch (err) {
    console.error(`[SAY] Envoi impossible dans #${channel.name} :`, err.message);
    return null;
  }
}

async function safeDelete(msg) {
  if (!msg) return;
  try { await msg.delete(); } catch (_) {}
}

function resolveChannels(message, targetsPart) {
  const channels = new Set();

  // Mentions #salon
  for (const ch of message.mentions.channels.values()) {
    if (ch.isTextBased()) channels.add(ch);
  }

  // IDs bruts → salon ou catégorie
  const ids = targetsPart.match(/\d{17,20}/g) ?? [];
  for (const id of ids) {
    const target = message.guild.channels.cache.get(id);
    if (!target) continue;

    if (target.type === 4) {
      // Catégorie → tous les enfants textuels
      message.guild.channels.cache
        .filter(c => c.parentId === target.id && c.isTextBased())
        .forEach(ch => channels.add(ch));
    } else if (target.isTextBased()) {
      channels.add(target);
    }
  }

  // Aucune cible → salon courant
  if (channels.size === 0) channels.add(message.channel);

  return channels;
}

function parseRepeat(str) {
  const match = str.match(/--\s*repeat\s*:\s*((?:\d+h)?(?:\d+m)?)\s*$/i);
  if (!match || !match[1]) return { text: str.trim(), ms: null };

  const text    = str.slice(0, match.index).trim();
  const hours   = parseInt(match[1].match(/(\d+)h/i)?.[1] ?? 0);
  const minutes = parseInt(match[1].match(/(\d+)m/i)?.[1] ?? 0);
  const ms      = (hours * 60 + minutes) * 60_000;

  return { text, ms };
}

// ============================================================
//  SAY — Map globale : channelId → entry
// ============================================================
if (!global.sayData) global.sayData = new Map();

// ============================================================
//  Helpers
// ============================================================

async function safeSend(channel, text) {
  try {
    return await channel.send({
      content: text,
      allowedMentions: { parse: ['users', 'roles', 'everyone'] },
    });
  } catch (err) {
    console.error(`[SAY] #${channel.name} :`, err.message);
    return null;
  }
}

async function safeDelete(msg) {
  try { await msg?.delete(); } catch (_) {}
}

async function safeReact(msg, emoji) {
  try { await msg?.react(emoji); } catch (_) {}
}

function parseDuration(str) {
  // Supporte : 30s / 5m / 1h / 1h30m / 2h15m30s
  const match = str.match(/^((?:\d+h)?(?:\d+m)?(?:\d+s)?)$/i);
  if (!match || !match[1]) return null;

  const h = parseInt(match[1].match(/(\d+)h/i)?.[1] ?? 0);
  const m = parseInt(match[1].match(/(\d+)m/i)?.[1] ?? 0);
  const s = parseInt(match[1].match(/(\d+)s/i)?.[1] ?? 0);
  const ms = (h * 3600 + m * 60 + s) * 1000;

  return ms >= 10_000 ? ms : null; // minimum 10s
}

function resolveChannels(message, targetsPart) {
  const channels = new Set();

  for (const ch of message.mentions.channels.values()) {
    if (ch.isTextBased()) channels.add(ch);
  }

  const ids = targetsPart.match(/\d{17,20}/g) ?? [];
  for (const id of ids) {
    const target = message.guild.channels.cache.get(id);
    if (!target) continue;
    if (target.type === 4) {
      message.guild.channels.cache
        .filter(c => c.parentId === target.id && c.isTextBased())
        .forEach(ch => channels.add(ch));
    } else if (target.isTextBased()) {
      channels.add(target);
    }
  }

  if (channels.size === 0) channels.add(message.channel);
  return channels;
}

// ============================================================
//  Stop propre d'un repeat
// ============================================================
async function stopRepeat(channelId, notify = false) {
  const entry = global.sayData.get(channelId);
  if (!entry) return;

  clearInterval(entry.interval);
  global.sayData.delete(channelId);

  // Supprimer le dernier message du bot
  await safeDelete(entry.currentMsg);

  if (notify && entry.channel) {
    const notif = await safeSend(entry.channel, '⏹ Repeat arrêté.');
    if (notif) setTimeout(() => safeDelete(notif), 4_000);
  }
}

// ============================================================
//  Lancer un repeat sur un salon
// ============================================================
async function startRepeat(channel, text, ms) {
  // Stopper l'éventuel repeat déjà actif
  await stopRepeat(channel.id);

  // Envoi du premier message
  const firstMsg = await safeSend(channel, text);
  if (!firstMsg) return;

  // Réaction stop sur le premier message
  await safeReact(firstMsg, '⏹️');

  // Objet entry (référence partagée)
  const entry = {
    channel,
    text,
    ms,
    currentMsg: firstMsg,
    interval: null,
  };

  // Collector de réaction sur chaque message posté
  function attachCollector(msg) {
    const collector = msg.createReactionCollector({
      filter: (reaction, user) =>
        reaction.emoji.name === '⏹️' && !user.bot,
      time: ms - 500, // expire juste avant le prochain repeat
      max: 1,
    });

    collector.on('collect', async (_, user) => {
      await stopRepeat(channel.id, false);
      const notif = await safeSend(channel, `⏹ Repeat arrêté par <@${user.id}>.`);
      if (notif) setTimeout(() => safeDelete(notif), 5_000);
    });
  }

  attachCollector(firstMsg);

  // Interval
  entry.interval = setInterval(async () => {
    const oldMsg = entry.currentMsg;

    // Envoyer d'abord le nouveau message
    const newMsg = await safeSend(channel, text);
    if (!newMsg) return;

    // Mettre à jour l'entrée AVANT de supprimer l'ancien
    entry.currentMsg = newMsg;
    if (global.sayData.has(channel.id)) {
      global.sayData.get(channel.id).currentMsg = newMsg;
    }

    // Supprimer l'ancien après
    await safeDelete(oldMsg);

    // Réaction stop sur le nouveau message
    await safeReact(newMsg, '⏹️');

    // Attacher le collector sur le nouveau message
    attachCollector(newMsg);

  }, ms);

  global.sayData.set(channel.id, entry);
}

// ============================================================
//  SAY — Map globale : channelId → entry
// ============================================================
if (!global.sayData) global.sayData = new Map();

// ============================================================
//  Helpers
// ============================================================

async function safeSend(channel, text) {
  try {
    return await channel.send({
      content: text,
      allowedMentions: { parse: ['users', 'roles', 'everyone'] },
    });
  } catch (err) {
    console.error(`[SAY] #${channel.name} :`, err.message);
    return null;
  }
}

async function safeDelete(msg) {
  try { await msg?.delete(); } catch (_) {}
}

function parseDuration(str) {
  const match = str.match(/^((?:\d+h)?(?:\d+m)?(?:\d+s)?)$/i);
  if (!match || !match[1]) return null;

  const h  = parseInt(match[1].match(/(\d+)h/i)?.[1] ?? 0);
  const m  = parseInt(match[1].match(/(\d+)m/i)?.[1] ?? 0);
  const s  = parseInt(match[1].match(/(\d+)s/i)?.[1] ?? 0);
  const ms = (h * 3600 + m * 60 + s) * 1000;

  return ms >= 10_000 ? ms : null;
}

function resolveChannels(message, targetsPart) {
  const channels = new Set();

  for (const ch of message.mentions.channels.values()) {
    if (ch.isTextBased()) channels.add(ch);
  }

  const ids = targetsPart.match(/\d{17,20}/g) ?? [];
  for (const id of ids) {
    const target = message.guild.channels.cache.get(id);
    if (!target) continue;
    if (target.type === 4) {
      message.guild.channels.cache
        .filter(c => c.parentId === target.id && c.isTextBased())
        .forEach(ch => channels.add(ch));
    } else if (target.isTextBased()) {
      channels.add(target);
    }
  }

  if (channels.size === 0) channels.add(message.channel);
  return channels;
}

// ============================================================
//  Stop propre d'un repeat
// ============================================================
async function stopRepeat(channelId, { silent = false, stoppedBy = null } = {}) {
  const entry = global.sayData.get(channelId);
  if (!entry) return false;

  clearInterval(entry.interval);
  global.sayData.delete(channelId);
  await safeDelete(entry.currentMsg);

  if (!silent && entry.channel) {
    const who   = stoppedBy ? `<@${stoppedBy}>` : 'automatiquement';
    const notif = await safeSend(entry.channel, `⏹ Repeat arrêté par ${who}.`);
    if (notif) setTimeout(() => safeDelete(notif), 4_000);
  }

  return true;
}

// ============================================================
//  Lancer un repeat sur un salon
// ============================================================
async function startRepeat(channel, text, ms) {
  await stopRepeat(channel.id, { silent: true });

  const firstMsg = await safeSend(channel, text);
  if (!firstMsg) return;

  const entry = {
    channel,
    text,
    ms,
    currentMsg: firstMsg,
    interval:   null,
  };

  entry.interval = setInterval(async () => {
    const oldMsg = entry.currentMsg;

    // Envoyer le nouveau AVANT de supprimer l'ancien → zéro bug
    const newMsg = await safeSend(channel, text);
    if (!newMsg) return;

    entry.currentMsg = newMsg;
    if (global.sayData.has(channel.id)) {
      global.sayData.get(channel.id).currentMsg = newMsg;
    }

    await safeDelete(oldMsg);

  }, ms);

  global.sayData.set(channel.id, entry);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : STATS VIP
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helpers config ────────────────────────────────────────────────────────────

function getVipStatsConfig(guildId) {
  const raw = getConfig(guildId, 'vip_stats_config', null);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function saveVipStatsConfig(guildId, config) {
  setConfig(guildId, 'vip_stats_config', JSON.stringify(config));
}

// ── Builder principal ─────────────────────────────────────────────────────────

async function buildVipStatsEmbed(guild, config) {

  // ── Récupération des données live ─────────────────────────────

  let totalTickets = 0;
  try {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?'
    ).get(guild.id);
    totalTickets = row?.count ?? 0;
  } catch { totalTickets = 0; }

  let openTickets = 0;
  try {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND status = ?'
    ).get(guild.id, 'open');
    openTickets = row?.count ?? 0;
  } catch { openTickets = 0; }

  // Lien actif ou non (on regarde si la config invite existe)
  let lienStatus = '❌ Inactif';
  try {
    const inviteRaw = getConfig(guild.id, 'invite_link', null);
    lienStatus = inviteRaw ? '<:certif:1511885381782732990> Actif' : '❌ Inactif';
  } catch { lienStatus = '❌ Inactif'; }

  // Prix VIP
  let prixVip = '—';
  try {
    const prix = getConfig(guild.id, 'vip_price', null);
    prixVip = prix ?? '—';
  } catch { prixVip = '—'; }

  // Membres VIP (ceux qui ont le rôle VIP configuré)
  let membresVip = 0;
  try {
    const roleId = getConfig(guild.id, 'vip_role', null);
    if (roleId) {
      await guild.members.fetch().catch(() => {});
      membresVip = guild.members.cache.filter(
        m => !m.user.bot && m.roles.cache.has(roleId)
      ).size;
    }
  } catch { membresVip = 0; }

  // ── Construction des champs ───────────────────────────────────

  const title     = config.title     || `Statistiques VIP — ${guild.name}`;
  const color     = config.color     ?? 0xf1c40f;
  const thumbnail = config.thumbnail ?? guild.iconURL({ dynamic: true, size: 256 });

  const defaultFields = [
    {
      key   : 'tickets',
      emoji : config.emojiTickets || '🎫',
      label : config.labelTickets || 'Tickets',
      value : totalTickets.toLocaleString('fr-FR'),
    },
    {
      key   : 'tickets_open',
      emoji : config.emojiTicketsOpen || '📂',
      label : config.labelTicketsOpen || 'Tickets Ouverts',
      value : openTickets.toLocaleString('fr-FR'),
    },
    {
      key   : 'lien',
      emoji : config.emojiLien || '🔗',
      label : config.labelLien || 'Lien',
      value : lienStatus,
    },
    {
      key   : 'prix',
      emoji : config.emojiPrix || '💰',
      label : config.labelPrix || 'Prix VIP',
      value : prixVip,
    },
    {
      key   : 'membres_vip',
      emoji : config.emojiMembresVip || '👑',
      label : config.labelMembresVip || 'Membres VIP',
      value : membresVip.toLocaleString('fr-FR'),
    },
  ];

  const customFields = Array.isArray(config.customFields) ? config.customFields : [];

  const allFields = [
    ...defaultFields.map(f => {
      const override = customFields.find(c => c.key === f.key);
      return override ? { ...f, ...override } : f;
    }),
    ...customFields.filter(c => !defaultFields.find(f => f.key === c.key)),
  ].filter(f => !f.hidden);

  const desc = allFields
    .map(f => `${f.emoji} **${f.label} :** ${f.value}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc);

  if (thumbnail) {
    try { embed.setThumbnail(thumbnail); } catch {}
  }

  if (config.footerText) {
    const footerOptions = { text: config.footerText };
    if (config.footerIcon) {
      try { footerOptions.iconURL = config.footerIcon; } catch {}
    }
    try { embed.setFooter(footerOptions); } catch {}
  }

  return embed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDE : !stats
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdStats(message) {
  try {
    const config = getVipStatsConfig(message.guild.id);
    const embed  = await buildVipStatsEmbed(message.guild, config);
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('[STATS]', err);
    await message.reply({
      embeds: [errorEmbed('Erreur', 'Impossible de charger les statistiques.')]
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : STATS VIP
// ═══════════════════════════════════════════════════════════════════════════════

// ── Map globale pour les intervals d'actualisation ────────────────────────────
const statsAutoRefresh = new Map();

// ── Helpers config ────────────────────────────────────────────────────────────

function getVipStatsConfig(guildId) {
  const raw = getConfig(guildId, 'vip_stats_config', null);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function saveVipStatsConfig(guildId, config) {
  setConfig(guildId, 'vip_stats_config', JSON.stringify(config));
}

// ── Helper : résoudre les IDs de rôles VIP ────────────────────────────────────

function parseVipRoleIds(guildId) {
  const raw = getConfig(guildId, 'vip_role', null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw ? [raw] : [];
  }
}

// ── Helper : compter les membres VIP (multi-serveurs) ────────────────────────

async function countVipMembers(guildId) {
  const roleIds = parseVipRoleIds(guildId);
  if (roleIds.length === 0) return 0;

  const counted = new Set();

  for (const roleId of roleIds) {
    for (const g of client.guilds.cache.values()) {
      const role = g.roles.cache.get(roleId);
      if (!role) continue;

      try { await g.members.fetch(); } catch {}

      g.members.cache
        .filter(m => !m.user.bot && m.roles.cache.has(roleId))
        .forEach(m => counted.add(m.user.id));

      break;
    }
  }

  return counted.size;
}

// ── Refresh immédiat — Fonction centrale ──────────────────────────────────────

async function triggerStatsRefresh(guildId) {
  try {
    const config = getVipStatsConfig(guildId);
    if (!config.autoRefresh)          return;
    if (!config.autoRefreshChannelId) return;
    if (!config.autoRefreshMessageId) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const ch = guild.channels.cache.get(config.autoRefreshChannelId);
    if (!ch) return;

    const embed = await buildVipStatsEmbed(guild, config);
    const now   = new Date().toLocaleTimeString('fr-FR', {
      hour: '2-digit', minute: '2-digit'
    });

    const footerText    = config.footerText
      ? `${config.footerText} • Aujourd'hui à ${now}`
      : `Aujourd'hui à ${now}`;
    const footerOptions = { text: footerText };
    if (config.footerIcon) {
      try { footerOptions.iconURL = config.footerIcon; } catch {}
    }
    try { embed.setFooter(footerOptions); } catch {}

    try {
      const msg = await ch.messages.fetch(config.autoRefreshMessageId);
      await msg.edit({ embeds: [embed] });
    } catch {
      const newMsg = await ch.send({ embeds: [embed] });
      config.autoRefreshMessageId = newMsg.id;
      saveVipStatsConfig(guildId, config);
    }
  } catch (err) {
    console.error('[STATS TRIGGER REFRESH]', err);
  }
}

// ── Builder principal ─────────────────────────────────────────────────────────

async function buildVipStatsEmbed(guild, config) {

  // ── Tickets total ──────────────────────────────────────────────
  let totalTickets = 0;
  try {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?'
    ).get(guild.id);
    totalTickets = row?.count ?? 0;
  } catch { totalTickets = 0; }

  // ── Tickets ouverts (non fermés) ──────────────────────────────
  let openTickets = 0;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM tickets
       WHERE guild_id = ? AND (status = 'open' OR status = 'claimed' OR status IS NULL)`
    ).get(guild.id);
    openTickets = row?.count ?? 0;
  } catch { openTickets = 0; }

  // ── Tickets actifs (salon encore existant dans Discord) ───────
  let activeTickets = 0;
  try {
    const rows = db.prepare(
      `SELECT channel_id FROM tickets
       WHERE guild_id = ? AND status != 'closed' AND channel_id IS NOT NULL`
    ).all(guild.id);

    try { await guild.channels.fetch(); } catch {}

    for (const row of rows) {
      if (guild.channels.cache.has(row.channel_id)) {
        activeTickets++;
      }
    }
  } catch { activeTickets = 0; }

  // ── Lien actif ou non ─────────────────────────────────────────
  let lienStatus = '❌ Inactif';
  try {
    const inviteRaw = getConfig(guild.id, 'invite_link', null);
    lienStatus = inviteRaw ? '<:certif:1511885381782732990> Actif' : '❌ Inactif';
  } catch { lienStatus = '❌ Inactif'; }

  // ── Prix VIP ──────────────────────────────────────────────────
  let prixVip = '—';
  try {
    const prix = getConfig(guild.id, 'vip_price', null);
    prixVip = prix ?? '—';
  } catch { prixVip = '—'; }

  // ── Membres VIP (multi-rôles, multi-serveurs) ─────────────────
  let membresVip = 0;
  try {
    membresVip = await countVipMembers(guild.id);
  } catch { membresVip = 0; }

  // ── Construction de l'embed ───────────────────────────────────

  const title     = config.title     || `Statistiques VIP — ${guild.name}`;
  const color     = config.color     ?? 0xf1c40f;
  const thumbnail = config.thumbnail ?? guild.iconURL({ dynamic: true, size: 256 });

  const defaultFields = [
    {
      key   : 'tickets',
      emoji : config.emojiTickets        || '🎫',
      label : config.labelTickets        || 'Tickets',
      value : totalTickets.toLocaleString('fr-FR'),
    },
    {
      key   : 'tickets_open',
      emoji : config.emojiTicketsOpen    || '📂',
      label : config.labelTicketsOpen    || 'Tickets Ouverts',
      value : openTickets.toLocaleString('fr-FR'),
    },
    {
      key   : 'tickets_active',
      emoji : config.emojiTicketsActive  || '🟢',
      label : config.labelTicketsActive  || 'Tickets Actifs',
      value : activeTickets.toLocaleString('fr-FR'),
    },
    {
      key   : 'lien',
      emoji : config.emojiLien           || '🔗',
      label : config.labelLien           || 'Lien',
      value : lienStatus,
    },
    {
      key   : 'prix',
      emoji : config.emojiPrix           || '💰',
      label : config.labelPrix           || 'Prix VIP',
      value : prixVip,
    },
    {
      key   : 'membres_vip',
      emoji : config.emojiMembresVip     || '👑',
      label : config.labelMembresVip     || 'Membres VIP',
      value : membresVip.toLocaleString('fr-FR'),
    },
  ];

  const customFields = Array.isArray(config.customFields) ? config.customFields : [];

  const allFields = [
    ...defaultFields.map(f => {
      const override = customFields.find(c => c.key === f.key);
      return override ? { ...f, ...override } : f;
    }),
    ...customFields.filter(c => !defaultFields.find(f => f.key === c.key)),
  ].filter(f => !f.hidden);

  const desc = allFields
    .map(f => `${f.emoji} **${f.label} :** ${f.value}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc);

  if (thumbnail) {
    try { embed.setThumbnail(thumbnail); } catch {}
  }

  if (config.footerText) {
    const footerOptions = { text: config.footerText };
    if (config.footerIcon) {
      try { footerOptions.iconURL = config.footerIcon; } catch {}
    }
    try { embed.setFooter(footerOptions); } catch {}
  }

  return embed;
}

// ── Système d'actualisation automatique ──────────────────────────────────────

async function startStatsAutoRefresh(guildId) {
  stopStatsAutoRefresh(guildId);

  const config = getVipStatsConfig(guildId);
  if (!config.autoRefresh)          return;
  if (!config.autoRefreshChannelId) return;
  if (!config.autoRefreshMessageId) return;

  const intervalMs = (config.autoRefreshInterval ?? 5) * 60 * 1000;
  if (intervalMs < 60000) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const doRefresh = async () => {
    try {
      const cfg = getVipStatsConfig(guildId);
      if (!cfg.autoRefresh) {
        stopStatsAutoRefresh(guildId);
        return;
      }

      const g  = client.guilds.cache.get(guildId);
      if (!g) return;

      const ch = g.channels.cache.get(cfg.autoRefreshChannelId);
      if (!ch) return;

      const embed = await buildVipStatsEmbed(g, cfg);
      const now   = new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit'
      });

      const footerText    = cfg.footerText
        ? `${cfg.footerText} • Aujourd'hui à ${now}`
        : `Aujourd'hui à ${now}`;
      const footerOptions = { text: footerText };
      if (cfg.footerIcon) {
        try { footerOptions.iconURL = cfg.footerIcon; } catch {}
      }
      try { embed.setFooter(footerOptions); } catch {}

      try {
        const msg = await ch.messages.fetch(cfg.autoRefreshMessageId);
        await msg.edit({ embeds: [embed] });
      } catch {
        const newMsg = await ch.send({ embeds: [embed] });
        cfg.autoRefreshMessageId = newMsg.id;
        saveVipStatsConfig(guildId, cfg);
      }
    } catch (err) {
      console.error('[STATS AUTO-REFRESH]', err);
    }
  };

  const interval = setInterval(doRefresh, intervalMs);
  statsAutoRefresh.set(guildId, { interval, intervalMs });
  console.log(`[STATS] Auto-refresh démarré — guild ${guildId} (${intervalMs / 60000} min)`);
}

function stopStatsAutoRefresh(guildId) {
  const entry = statsAutoRefresh.get(guildId);
  if (entry) {
    clearInterval(entry.interval);
    statsAutoRefresh.delete(guildId);
    console.log(`[STATS] Auto-refresh stoppé — guild ${guildId}`);
  }
}

async function initAllStatsAutoRefresh() {
  for (const [guildId] of client.guilds.cache) {
    const config = getVipStatsConfig(guildId);
    if (config.autoRefresh) {
      await startStatsAutoRefresh(guildId);
    }
  }
}

// ── Events Discord pour refresh immédiat ─────────────────────────────────────

// Nouveau membre / membre parti
client.on('guildMemberAdd', async (member) => {
  await triggerStatsRefresh(member.guild.id);
});

client.on('guildMemberRemove', async (member) => {
  await triggerStatsRefresh(member.guild.id);
});

// Rôle VIP donné ou retiré
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const oldRoles = oldMember.roles.cache.map(r => r.id).sort().join(',');
    const newRoles = newMember.roles.cache.map(r => r.id).sort().join(',');
    if (oldRoles === newRoles) return;

    const vipRoleIds  = parseVipRoleIds(newMember.guild.id);
    const hasVipChange = vipRoleIds.some(id =>
      oldMember.roles.cache.has(id) !== newMember.roles.cache.has(id)
    );

    if (hasVipChange) {
      await triggerStatsRefresh(newMember.guild.id);
    }
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDE : !stats
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdStats(message) {
  try {
    const config = getVipStatsConfig(message.guild.id);
    const embed  = await buildVipStatsEmbed(message.guild, config);
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('[STATS]', err);
    await message.reply({
      embeds: [errorEmbed('Erreur', 'Impossible de charger les statistiques.')]
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDE : !statsconfig
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdStatsConfig(message, args) {
  if (!isAdmin(message.member)) {
    return message.reply({
      embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')]
    });
  }

  const guild  = message.guild;
  const config = getVipStatsConfig(guild.id);
  const sub    = args[0]?.toLowerCase();

  // ── Aide ──────────────────────────────────────────────────────
  if (!sub || sub === 'help') {
    const embed = new EmbedBuilder()
      .setColor(getDefaultColor(guild.id))
      .setTitle('📊 Configuration Stats VIP — Aide')
      .setDescription([
        '**🎨 Apparence**',
        '`statsconfig title <titre>` — Titre de l\'embed',
        '`statsconfig color <#hex>` — Couleur de l\'embed',
        '`statsconfig thumbnail <url | reset>` — Miniature',
        '',
        '**📝 Footer**',
        '`statsconfig footer <texte>` — Texte du footer',
        '`statsconfig footericon <url | reset>` — Icône du footer',
        '`statsconfig footerclear` — Supprimer le footer',
        '',
        '**💰 Valeurs configurables**',
        '`statsconfig setprix <prix>` — Définir le prix VIP',
        '`statsconfig setlien <url | reset>` — Définir le lien invite',
        '`statsconfig setviprole <@role|ID> [...]` — Définir le(s) rôle(s) VIP',
        '`statsconfig setviprole reset` — Supprimer les rôles VIP',
        '',
        '**🔄 Actualisation automatique**',
        '`statsconfig refresh on <#salon>` — Activer l\'auto-refresh',
        '`statsconfig refresh off` — Désactiver l\'auto-refresh',
        '`statsconfig refresh interval <minutes>` — Intervalle (min: 1, défaut: 5)',
        '`statsconfig refresh now` — Forcer une mise à jour immédiate',
        '`statsconfig refresh status` — Voir le statut',
        '',
        '**🔢 Champs par défaut**',
        '`statsconfig emoji <key> <emoji>` — Emoji d\'un champ',
        '`statsconfig label <key> <label>` — Label d\'un champ',
        '`statsconfig hide <key>` — Masquer un champ',
        '`statsconfig show <key>` — Afficher un champ',
        '',
        '**➕ Champs custom**',
        '`statsconfig addfield <key> <emoji> <label> | <valeur>` — Ajouter un champ',
        '`statsconfig setvalue <key> <valeur>` — Modifier la valeur d\'un champ custom',
        '`statsconfig removefield <key>` — Supprimer un champ custom',
        '',
        '**🔧 Autres**',
        '`statsconfig view` — Voir la config actuelle',
        '`statsconfig preview` — Prévisualiser',
        '`statsconfig reset` — Tout réinitialiser',
        '',
        '**🔑 Keys :** `tickets` `tickets_open` `tickets_active` `lien` `prix` `membres_vip`',
        '',
        '💡 *Les emojis animés du serveur sont supportés !*',
        '💡 *Le refresh se déclenche aussi automatiquement lors de chaque changement.*',
      ].join('\n'));
    return message.reply({ embeds: [embed] });
  }

  // ── Titre ──────────────────────────────────────────────────────
  if (sub === 'title') {
    const title = args.slice(1).join(' ');
    if (!title) return message.reply({
      embeds: [errorEmbed('Erreur', 'Fournissez un titre.')]
    });
    config.title = title;
    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Titre : **${title}**`)]
    });
  }

  // ── Couleur ────────────────────────────────────────────────────
  if (sub === 'color' || sub === 'colour') {
    const hex = args[1]?.replace('#', '');
    if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return message.reply({
      embeds: [errorEmbed('Erreur', 'Couleur hex invalide. Ex: `#FFD700`')]
    });
    config.color = parseInt(hex, 16);
    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(config.color)
        .setDescription(`✅ Couleur mise à jour : **#${hex.toUpperCase()}**`)]
    });
  }

  // ── Thumbnail ──────────────────────────────────────────────────
  if (sub === 'thumbnail') {
    const val = args[1];
    if (!val) return message.reply({
      embeds: [errorEmbed('Erreur', 'Fournissez une URL ou `reset`.')]
    });

    if (val.toLowerCase() === 'reset') {
      delete config.thumbnail;
      saveVipStatsConfig(guild.id, config);
      await triggerStatsRefresh(guild.id);
      return message.reply({
        embeds: [successEmbed(guild.id, 'Stats config', '✅ Miniature réinitialisée.')]
      });
    }

    if (!/^https?:\/\/.+/.test(val)) return message.reply({
      embeds: [errorEmbed('Erreur', 'URL invalide.')]
    });

    config.thumbnail = val;
    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(getDefaultColor(guild.id))
        .setDescription('✅ Miniature mise à jour.')
        .setThumbnail(val)]
    });
  }

  // ── Footer texte ───────────────────────────────────────────────
  if (sub === 'footer') {
    const text = args.slice(1).join(' ');
    if (!text) return message.reply({
      embeds: [errorEmbed('Erreur', 'Fournissez un texte de footer.')]
    });
    config.footerText = text;
    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Footer : **${text}**`)]
    });
  }

  // ── Footer icône ───────────────────────────────────────────────
  if (sub === 'footericon') {
    const val = args[1];
    if (!val) return message.reply({
      embeds: [errorEmbed('Erreur', 'Fournissez une URL ou `reset`.')]
    });

    if (val.toLowerCase() === 'reset') {
      delete config.footerIcon;
      saveVipStatsConfig(guild.id, config);
      await triggerStatsRefresh(guild.id);
      return message.reply({
        embeds: [successEmbed(guild.id, 'Stats config', '✅ Icône du footer supprimée.')]
      });
    }

    if (!/^https?:\/\/.+/.test(val)) return message.reply({
      embeds: [errorEmbed('Erreur', 'URL invalide.')]
    });

    config.footerIcon = val;
    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(getDefaultColor(guild.id))
        .setDescription('✅ Icône du footer mise à jour.')
        .setFooter({
          text   : config.footerText || 'Aperçu',
          iconURL: val,
        })]
    });
  }

  // ── Footer clear ───────────────────────────────────────────────
  if (sub === 'footerclear') {
    delete config.footerText;
    delete config.footerIcon;
    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', '✅ Footer supprimé.')]
    });
  }

  // ── Set Prix ───────────────────────────────────────────────────
  if (sub === 'setprix') {
    const prix = args.slice(1).join(' ');
    if (!prix) return message.reply({
      embeds: [errorEmbed('Erreur', 'Fournissez un prix. Ex: `10€/mois`')]
    });
    setConfig(guild.id, 'vip_price', prix);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Prix VIP : **${prix}**`)]
    });
  }

  // ── Set Lien ───────────────────────────────────────────────────
  if (sub === 'setlien') {
    const val = args[1];
    if (!val) return message.reply({
      embeds: [errorEmbed('Erreur', 'Fournissez une URL ou `reset`.')]
    });

    if (val.toLowerCase() === 'reset') {
      setConfig(guild.id, 'invite_link', '');
      await triggerStatsRefresh(guild.id);
      return message.reply({
        embeds: [successEmbed(guild.id, 'Stats config', '✅ Lien supprimé → statut : ❌ Inactif')]
      });
    }

    if (!/^https?:\/\/.+/.test(val)) return message.reply({
      embeds: [errorEmbed('Erreur', 'URL invalide.')]
    });

    setConfig(guild.id, 'invite_link', val);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', '✅ Lien défini → statut : ✅ Actif')]
    });
  }

  // ── Set Rôle VIP ───────────────────────────────────────────────
  if (sub === 'setviprole') {

    if (args[1]?.toLowerCase() === 'reset') {
      setConfig(guild.id, 'vip_role', '');
      await triggerStatsRefresh(guild.id);
      return message.reply({
        embeds: [successEmbed(guild.id, 'Stats config', '✅ Rôle(s) VIP supprimé(s).')]
      });
    }

    const roleIds = new Set();

    for (const role of message.mentions.roles.values()) {
      roleIds.add(role.id);
    }
    for (const arg of args.slice(1)) {
      if (/^\d{17,20}$/.test(arg)) roleIds.add(arg);
    }

    if (roleIds.size === 0) {
      return message.reply({
        embeds: [errorEmbed('Erreur', [
          'Fournissez un ou plusieurs rôles ou IDs de rôles.',
          '',
          '**Exemples :**',
          '`statsconfig setviprole @VIP`',
          '`statsconfig setviprole @VIP1 @VIP2`',
          '`statsconfig setviprole 123456789012345678`',
          '`statsconfig setviprole 123456789012345678 987654321098765432`',
          '`statsconfig setviprole reset` — Supprimer',
        ].join('\n'))]
      });
    }

    const resolvedRoles = [];
    const notFound      = [];

    for (const roleId of roleIds) {
      let found = false;

      for (const g of client.guilds.cache.values()) {
        let role = g.roles.cache.get(roleId);
        if (!role) {
          try {
            await g.roles.fetch(roleId);
            role = g.roles.cache.get(roleId);
          } catch {}
        }

        if (role) {
          resolvedRoles.push({
            id       : role.id,
            name     : role.name,
            guildId  : g.id,
            guildName: g.name,
          });
          found = true;
          break;
        }
      }

      if (!found) notFound.push(roleId);
    }

    if (resolvedRoles.length === 0) {
      return message.reply({
        embeds: [errorEmbed('Erreur',
          `Aucun rôle trouvé pour : ${notFound.map(id => `\`${id}\``).join(', ')}\n` +
          'Vérifiez que le bot est bien dans le serveur concerné.'
        )]
      });
    }

    setConfig(guild.id, 'vip_role', JSON.stringify(resolvedRoles.map(r => r.id)));
    await triggerStatsRefresh(guild.id);

    const lines = resolvedRoles.map(r =>
      r.guildId === guild.id
        ? `✅ <@&${r.id}> — **${r.name}** *(ce serveur)*`
        : `✅ **${r.name}** \`${r.id}\` *(serveur : ${r.guildName})*`
    );
    if (notFound.length > 0) {
      lines.push('');
      lines.push(`⚠️ Introuvables : ${notFound.map(id => `\`${id}\``).join(', ')}`);
    }

    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(getDefaultColor(guild.id))
        .setTitle('👑 Rôle(s) VIP défini(s)')
        .setDescription(lines.join('\n'))]
    });
  }

  // ── Auto-Refresh ───────────────────────────────────────────────
  if (sub === 'refresh') {
    const action = args[1]?.toLowerCase();

    // refresh on <#salon>
    if (action === 'on') {
      const channel = message.mentions.channels.first()
        || (args[2] && /^\d{17,20}$/.test(args[2]) && guild.channels.cache.get(args[2]));

      if (!channel) return message.reply({
        embeds: [errorEmbed('Erreur',
          'Mentionnez un salon ou fournissez son ID.\nEx: `statsconfig refresh on #stats`')]
      });

      if (!channel.isTextBased()) return message.reply({
        embeds: [errorEmbed('Erreur', 'Ce salon n\'est pas un salon textuel.')]
      });

      const embed = await buildVipStatsEmbed(guild, config);
      const now   = new Date().toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit'
      });
      const footerText    = config.footerText
        ? `${config.footerText} • Aujourd'hui à ${now}`
        : `Aujourd'hui à ${now}`;
      const footerOptions = { text: footerText };
      if (config.footerIcon) {
        try { footerOptions.iconURL = config.footerIcon; } catch {}
      }
      try { embed.setFooter(footerOptions); } catch {}

      const statsMsg = await channel.send({ embeds: [embed] });

      config.autoRefresh          = true;
      config.autoRefreshChannelId = channel.id;
      config.autoRefreshMessageId = statsMsg.id;
      if (!config.autoRefreshInterval) config.autoRefreshInterval = 5;
      saveVipStatsConfig(guild.id, config);

      await startStatsAutoRefresh(guild.id);

      return message.reply({
        embeds: [new EmbedBuilder()
          .setColor(getDefaultColor(guild.id))
          .setTitle('🔄 Auto-refresh activé')
          .setDescription([
            `✅ Stats envoyées dans ${channel}`,
            `⏱️ Intervalle : **${config.autoRefreshInterval} minute(s)**`,
            '',
            '🔁 Le refresh se déclenche aussi automatiquement lors de chaque',
            'changement de ticket, lien, prix ou membre VIP.',
            '',
            `Pour changer l'intervalle : \`statsconfig refresh interval <minutes>\``,
            `Pour désactiver : \`statsconfig refresh off\``,
          ].join('\n'))]
      });
    }

    // refresh off
    if (action === 'off') {
      stopStatsAutoRefresh(guild.id);
      config.autoRefresh = false;
      saveVipStatsConfig(guild.id, config);
      return message.reply({
        embeds: [successEmbed(guild.id, 'Stats config', '✅ Auto-refresh désactivé.')]
      });
    }

    // refresh interval <minutes>
    if (action === 'interval') {
      const minutes = parseInt(args[2]);
      if (isNaN(minutes) || minutes < 1) return message.reply({
        embeds: [errorEmbed('Erreur',
          'Fournissez un nombre de minutes valide (minimum : 1).\nEx: `statsconfig refresh interval 10`')]
      });

      config.autoRefreshInterval = minutes;
      saveVipStatsConfig(guild.id, config);

      if (config.autoRefresh) {
        await startStatsAutoRefresh(guild.id);
        return message.reply({
          embeds: [successEmbed(guild.id, 'Stats config',
            `✅ Intervalle : **${minutes} minute(s)**\n🔄 Auto-refresh redémarré.`)]
        });
      }

      return message.reply({
        embeds: [successEmbed(guild.id, 'Stats config',
          `✅ Intervalle défini : **${minutes} minute(s)**\n*(Activez avec \`statsconfig refresh on #salon\`)*`)]
      });
    }

    // refresh now
    if (action === 'now') {
      if (!config.autoRefresh || !config.autoRefreshChannelId || !config.autoRefreshMessageId) {
        return message.reply({
          embeds: [errorEmbed('Erreur',
            'L\'auto-refresh n\'est pas activé. Utilisez `statsconfig refresh on #salon`.')]
        });
      }

      await triggerStatsRefresh(guild.id);
      return message.reply({
        embeds: [successEmbed(guild.id, 'Stats config', '✅ Stats mises à jour immédiatement.')]
      });
    }

    // refresh status
    if (action === 'status' || !action) {
      const entry     = statsAutoRefresh.get(guild.id);
      const isRunning = !!entry;
      const channel   = config.autoRefreshChannelId
        ? guild.channels.cache.get(config.autoRefreshChannelId)
        : null;

      const embed = new EmbedBuilder()
        .setColor(getDefaultColor(guild.id))
        .setTitle('🔄 Statut Auto-Refresh')
        .addFields(
          {
            name : '📡 État',
            value: config.autoRefresh && isRunning
              ? '🟢 **Actif**'
              : config.autoRefresh && !isRunning
                ? '🟡 **Configuré mais non démarré** *(redémarrez le bot)*'
                : '🔴 **Inactif**',
            inline: false,
          },
          {
            name : '📺 Salon',
            value: channel ? `${channel}` : 'Non défini',
            inline: true,
          },
          {
            name : '⏱️ Intervalle',
            value: `**${config.autoRefreshInterval ?? 5} minute(s)**`,
            inline: true,
          },
          {
            name : '💬 Message ID',
            value: config.autoRefreshMessageId
              ? `\`${config.autoRefreshMessageId}\``
              : 'Non défini',
            inline: false,
          },
          {
            name : '⚡ Triggers immédiats',
            value: [
              '🎫 Nouveau ticket / fermeture',
              '🔗 Changement de lien',
              '💰 Changement de prix',
              '👑 Rôle VIP donné / retiré',
              '👥 Membre rejoint / parti',
            ].join('\n'),
            inline: false,
          },
        );

      return message.reply({ embeds: [embed] });
    }

    return message.reply({
      embeds: [errorEmbed('Erreur', [
        'Sous-commande `refresh` inconnue.',
        '',
        '`statsconfig refresh on <#salon>` — Activer',
        '`statsconfig refresh off` — Désactiver',
        '`statsconfig refresh interval <minutes>` — Changer l\'intervalle',
        '`statsconfig refresh now` — Mise à jour immédiate',
        '`statsconfig refresh status` — Voir le statut',
      ].join('\n'))]
    });
  }

  // ── Emoji ──────────────────────────────────────────────────────
  if (sub === 'emoji') {
    const key   = args[1]?.toLowerCase();
    const emoji = args.slice(2).join(' ').trim();

    if (!key || !emoji) return message.reply({
      embeds: [errorEmbed('Erreur', 'Usage : `statsconfig emoji <key> <emoji>`')]
    });

    const emojiKeyMap = {
      tickets        : 'emojiTickets',
      tickets_open   : 'emojiTicketsOpen',
      tickets_active : 'emojiTicketsActive',
      lien           : 'emojiLien',
      prix           : 'emojiPrix',
      membres_vip    : 'emojiMembresVip',
    };

    if (emojiKeyMap[key]) {
      config[emojiKeyMap[key]] = emoji;
    } else {
      if (!Array.isArray(config.customFields)) config.customFields = [];
      const f = config.customFields.find(c => c.key === key);
      if (f) f.emoji = emoji;
      else config.customFields.push({ key, emoji, label: key, value: '—' });
    }

    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Emoji \`${key}\` : ${emoji}`)]
    });
  }

  // ── Label ──────────────────────────────────────────────────────
  if (sub === 'label') {
    const key   = args[1]?.toLowerCase();
    const label = args.slice(2).join(' ');

    if (!key || !label) return message.reply({
      embeds: [errorEmbed('Erreur', 'Usage : `statsconfig label <key> <label>`')]
    });

    const labelKeyMap = {
      tickets        : 'labelTickets',
      tickets_open   : 'labelTicketsOpen',
      tickets_active : 'labelTicketsActive',
      lien           : 'labelLien',
      prix           : 'labelPrix',
      membres_vip    : 'labelMembresVip',
    };

    if (labelKeyMap[key]) {
      config[labelKeyMap[key]] = label;
    } else {
      if (!Array.isArray(config.customFields)) config.customFields = [];
      const f = config.customFields.find(c => c.key === key);
      if (f) f.label = label;
      else config.customFields.push({ key, emoji: '❓', label, value: '—' });
    }

    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Label \`${key}\` : **${label}**`)]
    });
  }

  // ── Hide ───────────────────────────────────────────────────────
  if (sub === 'hide') {
    const key = args[1]?.toLowerCase();
    if (!key) return message.reply({
      embeds: [errorEmbed('Erreur', 'Usage : `statsconfig hide <key>`')]
    });

    if (!Array.isArray(config.customFields)) config.customFields = [];
    const f = config.customFields.find(c => c.key === key);
    if (f) { f.hidden = true; }
    else { config.customFields.push({ key, hidden: true }); }

    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Champ \`${key}\` masqué.`)]
    });
  }

  // ── Show ───────────────────────────────────────────────────────
  if (sub === 'show') {
    const key = args[1]?.toLowerCase();
    if (!key) return message.reply({
      embeds: [errorEmbed('Erreur', 'Usage : `statsconfig show <key>`')]
    });

    if (!Array.isArray(config.customFields)) config.customFields = [];
    const f = config.customFields.find(c => c.key === key);
    if (f) f.hidden = false;

    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Champ \`${key}\` affiché.`)]
    });
  }

  // ── Add Field ──────────────────────────────────────────────────
  if (sub === 'addfield') {
    const key = args[1]?.toLowerCase();
    if (!key) return message.reply({
      embeds: [errorEmbed('Erreur',
        'Usage : `statsconfig addfield <key> <emoji> <label> | <valeur>`')]
    });

    const rest  = args.slice(2).join(' ');
    const parts = rest.split('|');
    const left  = parts[0]?.trim().split(' ') ?? [];
    const emoji = left[0] ?? '❓';
    const label = left.slice(1).join(' ') || key;
    const value = parts[1]?.trim() || '—';

    if (!Array.isArray(config.customFields)) config.customFields = [];
    const existing = config.customFields.find(c => c.key === key);
    if (existing) {
      existing.emoji  = emoji;
      existing.label  = label;
      existing.value  = value;
      existing.hidden = false;
    } else {
      config.customFields.push({ key, emoji, label, value, custom: true });
    }

    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config',
        `✅ Champ \`${key}\` : ${emoji} **${label}** → ${value}`)]
    });
  }

  // ── Set Value ──────────────────────────────────────────────────
  if (sub === 'setvalue') {
    const key   = args[1]?.toLowerCase();
    const value = args.slice(2).join(' ');

    if (!key || !value) return message.reply({
      embeds: [errorEmbed('Erreur', 'Usage : `statsconfig setvalue <key> <valeur>`')]
    });

    if (!Array.isArray(config.customFields)) config.customFields = [];
    const f = config.customFields.find(c => c.key === key);
    if (!f) return message.reply({
      embeds: [errorEmbed('Erreur',
        `Champ \`${key}\` introuvable. Créez-le avec \`addfield\`.`)]
    });

    f.value = value;
    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Valeur \`${key}\` : **${value}**`)]
    });
  }

  // ── Remove Field ───────────────────────────────────────────────
  if (sub === 'removefield') {
    const key = args[1]?.toLowerCase();
    if (!key) return message.reply({
      embeds: [errorEmbed('Erreur', 'Usage : `statsconfig removefield <key>`')]
    });

    if (!Array.isArray(config.customFields)) config.customFields = [];
    config.customFields = config.customFields.filter(c => c.key !== key);

    saveVipStatsConfig(guild.id, config);
    await triggerStatsRefresh(guild.id);
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', `✅ Champ \`${key}\` supprimé.`)]
    });
  }

  // ── View ───────────────────────────────────────────────────────
  if (sub === 'view' || sub === 'list') {
    const customFields = Array.isArray(config.customFields) ? config.customFields : [];
    const inviteLink   = getConfig(guild.id, 'invite_link', null);
    const prixVip      = getConfig(guild.id, 'vip_price',  null);

    const vipRoleIds = parseVipRoleIds(guild.id);
    let vipRoleDisplay = 'Non défini';
    if (vipRoleIds.length > 0) {
      vipRoleDisplay = vipRoleIds.map(id => {
        const r = guild.roles.cache.get(id);
        return r ? `<@&${id}>` : `\`${id}\` *(autre serveur)*`;
      }).join(', ');
    }

    const entry     = statsAutoRefresh.get(guild.id);
    const refreshCh = config.autoRefreshChannelId
      ? guild.channels.cache.get(config.autoRefreshChannelId)
      : null;

    const defaultsLines = [
      `\`tickets\`         ${config.emojiTickets       || '🎫'} **${config.labelTickets       || 'Tickets'}**`,
      `\`tickets_open\`    ${config.emojiTicketsOpen   || '📂'} **${config.labelTicketsOpen   || 'Tickets Ouverts'}**`,
      `\`tickets_active\`  ${config.emojiTicketsActive || '🟢'} **${config.labelTicketsActive || 'Tickets Actifs'}**`,
      `\`lien\`            ${config.emojiLien          || '🔗'} **${config.labelLien          || 'Lien'}**`,
      `\`prix\`            ${config.emojiPrix          || '💰'} **${config.labelPrix          || 'Prix VIP'}**`,
      `\`membres_vip\`     ${config.emojiMembresVip    || '👑'} **${config.labelMembresVip    || 'Membres VIP'}**`,
    ];

    const embed = new EmbedBuilder()
      .setColor(getDefaultColor(guild.id))
      .setTitle('📊 Configuration Stats VIP')
      .addFields(
        {
          name : '🎨 Apparence',
          value: [
            `**Titre :** ${config.title || `Statistiques VIP — ${guild.name}`}`,
            `**Couleur :** ${config.color ? `#${config.color.toString(16).toUpperCase()}` : 'Défaut (or)'}`,
            `**Thumbnail :** ${config.thumbnail ? '[URL perso]' : 'Icône du serveur'}`,
          ].join('\n'),
          inline: false,
        },
        {
          name : '📝 Footer',
          value: [
            `**Texte :** ${config.footerText || 'Aucun'}`,
            `**Icône :** ${config.footerIcon ? '[URL]' : 'Aucune'}`,
          ].join('\n'),
          inline: false,
        },
        {
          name : '💰 Données VIP',
          value: [
            `**Prix :** ${prixVip || 'Non défini'}`,
            `**Lien :** ${inviteLink ? '✅ Actif' : '❌ Inactif'}`,
            `**Rôle(s) VIP :** ${vipRoleDisplay}`,
          ].join('\n'),
          inline: false,
        },
        {
          name : '🔄 Auto-Refresh',
          value: [
            `**État :** ${config.autoRefresh && entry ? '🟢 Actif' : '🔴 Inactif'}`,
            `**Salon :** ${refreshCh ? `${refreshCh}` : 'Non défini'}`,
            `**Intervalle :** ${config.autoRefreshInterval ?? 5} minute(s)`,
          ].join('\n'),
          inline: false,
        },
        {
          name : '🔢 Champs par défaut',
          value: defaultsLines.join('\n'),
          inline: false,
        },
        {
          name : '➕ Champs custom',
          value: customFields.length
            ? customFields.map(f =>
                `\`${f.key}\` ${f.emoji || ''} **${f.label || f.key}** = ${f.value || '—'} ${f.hidden ? '*(masqué)*' : ''}`
              ).join('\n')
            : 'Aucun',
          inline: false,
        },
      );

    return message.reply({ embeds: [embed] });
  }

  // ── Preview ────────────────────────────────────────────────────
  if (sub === 'preview') {
    try {
      const embed = await buildVipStatsEmbed(guild, config);
      embed.setTitle(`👁️ Aperçu — ${embed.data.title}`);
      return message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('[STATSCONFIG PREVIEW]', err);
      return message.reply({
        embeds: [errorEmbed('Erreur', 'Erreur lors de la prévisualisation.')]
      });
    }
  }

  // ── Reset ──────────────────────────────────────────────────────
  if (sub === 'reset') {
    stopStatsAutoRefresh(guild.id);
    saveVipStatsConfig(guild.id, {});
    return message.reply({
      embeds: [successEmbed(guild.id, 'Stats config', '✅ Configuration réinitialisée.')]
    });
  }

  // ── Sous-commande inconnue ─────────────────────────────────────
  return message.reply({
    embeds: [errorEmbed('Commande inconnue',
      `Sous-commande \`${sub}\` introuvable. Faites \`statsconfig help\` pour la liste.`)]
  });
}

// ============================================================
//  Commande : !say
// ============================================================

/**
 * !say [#salon / ID] -- <message> [-- repeat:durée]
 * !say stop [#salon / ID]   ← stoppe le repeat
 *
 * Exemples :
 *   ~say -- Bonjour !
 *   ~say #général -- Salut -- repeat:30m
 *   ~say #général #annonces -- Salut -- repeat:1h30m
 *   ~say stop              ← stop dans le salon courant
 *   ~say stop #général     ← stop dans #général
 *   ~say stop #a #b        ← stop dans plusieurs salons
 */
async function cmdSay(message, args, cfg) {
  try {
    const raw = message.content.slice(cfg.PREFIX.length + 'say'.length).trim();

    // ── Mode STOP ──────────────────────────────────────────────
    if (raw.toLowerCase().startsWith('stop')) {
      const stopPart = raw.slice(4).trim();
      const channels = resolveChannels(message, stopPart);

      let stopped = 0;
      for (const channel of channels) {
        const ok = await stopRepeat(channel.id, {
          silent:    false,
          stoppedBy: message.author.id,
        });
        if (ok) stopped++;
      }

      if (stopped === 0) {
        const notif = await message.reply('❌ Aucun repeat actif dans ce salon.');
        setTimeout(() => safeDelete(notif), 4_000);
      } else {
        await message.react('✅');
      }

      await safeDelete(message);
      return;
    }

    // ── Mode SAY ───────────────────────────────────────────────
    const sepIdx = raw.indexOf('--');
    if (sepIdx === -1) {
      return message.reply([
        '❌ **Utilisation :**',
        '> `~say [#salon / ID] -- message [-- repeat:durée]`',
        '> `~say stop [#salon / ID]`',
        '',
        '**Durées :** `30s` · `5m` · `1h` · `1h30m` · `2h15m30s`',
      ].join('\n'));
    }

    const targetsPart = raw.slice(0, sepIdx).trim();
    const rest        = raw.slice(sepIdx + 2).trim();

    const repeatReg   = /--\s*repeat\s*:\s*([^\s]+)\s*$/i;
    const repeatMatch = rest.match(repeatReg);

    const text      = repeatMatch ? rest.slice(0, repeatMatch.index).trim() : rest.trim();
    const repeatStr = repeatMatch?.[1] ?? null;

    if (!text) {
      return message.reply('❌ Le message ne peut pas être vide.');
    }

    let repeatMs = null;
    if (repeatStr) {
      repeatMs = parseDuration(repeatStr);
      if (!repeatMs) {
        return message.reply('❌ Durée invalide. Minimum **10 secondes**. Ex: `30s`, `5m`, `1h30m`');
      }
    }

    const channels = resolveChannels(message, targetsPart);

    for (const channel of channels) {
      if (repeatMs) {
        await startRepeat(channel, text, repeatMs);
      } else {
        await stopRepeat(channel.id, { silent: true });
        await safeSend(channel, text);
      }
    }

    // Supprimer la commande + confirmation discrète
    await safeDelete(message);
    const confirm = await message.channel.send('✅').catch(() => {});
    if (confirm) setTimeout(() => safeDelete(confirm), 2_000);

  } catch (err) {
    console.error('[SAY]', err);
    message.reply('❌ Une erreur est survenue.').catch(() => {});
  }
}

module.exports = { cmdSay };

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/** !setprefix <prefix> */
async function cmdSetPrefix(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const newPrefix = args[0];
  if (!newPrefix || newPrefix.length > 5) return message.reply({ embeds: [errorEmbed('Erreur', 'Préfixe invalide (1-5 caractères).')] });
  setConfig(message.guild.id, 'prefix', newPrefix);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Préfixe modifié', `Le préfixe est maintenant \`${newPrefix}\``)] });
}

/** !setlogchannel <#salon> */
async function cmdSetLogChannel(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const channel = message.mentions.channels.first();
  if (!channel) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un salon.')] });
  setConfig(message.guild.id, 'log_channel', channel.id);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Salon de logs', `Salon de logs défini sur ${channel}.`)] });
}

/** !setadminrole <@role> */
async function cmdSetAdminRole(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const role = message.mentions.roles.first();
  if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
  let adminRoles = [];
  try { adminRoles = JSON.parse(getConfig(message.guild.id, 'admin_roles', '[]')); } catch {}
  if (!adminRoles.includes(role.id)) adminRoles.push(role.id);
  setConfig(message.guild.id, 'admin_roles', JSON.stringify(adminRoles));
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle Admin', `${role} est maintenant un rôle administrateur.`)] });
}

/** !setmodrole <@role> */
async function cmdSetModRole(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const role = message.mentions.roles.first();
  if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
  let modRoles = [];
  try { modRoles = JSON.parse(getConfig(message.guild.id, 'mod_roles', '[]')); } catch {}
  if (!modRoles.includes(role.id)) modRoles.push(role.id);
  setConfig(message.guild.id, 'mod_roles', JSON.stringify(modRoles));
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle Modérateur', `${role} est maintenant un rôle modérateur.`)] });
}

/** !setmuterole <@role> */
async function cmdSetMuteRole(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const role = message.mentions.roles.first();
  if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
  setConfig(message.guild.id, 'mute_role', role.id);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle Muted', `${role} est maintenant le rôle Muted.`)] });
}

/** !autorole <@role|disable> */
async function cmdAutorole(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  if (args[0] === 'disable') {
    setConfig(message.guild.id, 'autorole', '');
    return message.reply({ embeds: [successEmbed(message.guild.id, 'Autorole', 'Autorole désactivé.')] });
  }
  const role = message.mentions.roles.first();
  if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle ou écrivez `disable`.')] });
  setConfig(message.guild.id, 'autorole', role.id);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Autorole', `${role} sera attribué aux nouveaux membres.`)] });
}

/** !setwelcome — configure le welcome */
async function cmdSetWelcome(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const subCmd = args[0];
  if (!subCmd) {
    const embed = new EmbedBuilder()
      .setColor(getDefaultColor(message.guild.id))
      .setTitle('⚙️ Configuration du Welcome')
      .setDescription('Sous-commandes disponibles :')
      .addFields(
        { name: '`setwelcome channel #salon`', value: 'Définit le salon de bienvenue', inline: false },
        { name: '`setwelcome message <texte>`', value: 'Définit le message (variables: {user}, {mention}, {server}, {count})', inline: false },
        { name: '`setwelcome embed <true|false>`', value: 'Active/désactive l\'embed de bienvenue', inline: false }
      );
    return message.reply({ embeds: [embed] });
  }

  if (subCmd === 'channel') {
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un salon.')] });
    setConfig(message.guild.id, 'welcome_channel', channel.id);
    return message.reply({ embeds: [successEmbed(message.guild.id, 'Welcome', `Salon de bienvenue: ${channel}`)] });
  }

  if (subCmd === 'message') {
    const text = args.slice(1).join(' ');
    if (!text) return message.reply({ embeds: [errorEmbed('Erreur', 'Entrez un message.')] });
    setConfig(message.guild.id, 'welcome_message', text);
    return message.reply({ embeds: [successEmbed(message.guild.id, 'Welcome', `Message: \`${text}\``)] });
  }

  if (subCmd === 'embed') {
    const val = args[1] === 'true' ? 'true' : 'false';
    setConfig(message.guild.id, 'welcome_embed', val);
    return message.reply({ embeds: [successEmbed(message.guild.id, 'Welcome', `Embed: \`${val}\``)] });
  }

  await message.reply({ embeds: [errorEmbed('Erreur', 'Sous-commande inconnue.')] });
}

/** !welcometest */
async function cmdWelcomeTest(message) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  await handleWelcome(message.member, true);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Test Welcome', 'Message de bienvenue envoyé.')] });
}

/** !setcolor <#HEX> */
async function cmdSetColor(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const hex = args[0];
  if (!hex || !isValidHex(hex)) return message.reply({ embeds: [errorEmbed('Couleur invalide', 'Format attendu: `#RRGGBB`')] });
  setConfig(message.guild.id, 'default_embed_color', hex);
  const embed = new EmbedBuilder()
    .setColor(hex)
    .setTitle('🎨 Couleur par défaut modifiée')
    .setDescription(`La couleur par défaut est maintenant \`${hex}\``)
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SYSTÈME D'EMBEDS
// ═══════════════════════════════════════════════════════════════════════════════

const defaultEmbedData = () => ({
  title: '', description: '', color: null, image: null, thumbnail: null,
  footer: { text: '', iconUrl: '' },
  author: { name: '', iconUrl: '', url: '' },
  url: '', timestamp: false, fields: []
});

function getEmbed(guildId, embedId) {
  const row = db.prepare('SELECT data FROM embeds WHERE guild_id = ? AND embed_id = ?').get(guildId, embedId);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function saveEmbed(guildId, embedId, data) {
  db.prepare('INSERT OR REPLACE INTO embeds (guild_id, embed_id, data) VALUES (?, ?, ?)').run(guildId, embedId, JSON.stringify(data));
}

/** Main embed command router */
async function cmdEmbed(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });

  switch (sub.toLowerCase()) {
    case 'create': return embedCreate(message, args);
    case 'title': return embedSetField(message, args, 'title');
    case 'description': return embedSetField(message, args, 'description');
    case 'color': return embedSetColor(message, args);
    case 'image': return embedSetImage(message, args);
    case 'thumbnail': return embedSetThumbnail(message, args);
    case 'footer': return embedSetFooter(message, args);
    case 'footericon': return embedSetFooterIcon(message, args);
    case 'author': return embedSetAuthorField(message, args, 'name');
    case 'authoricon': return embedSetAuthorField(message, args, 'iconUrl');
    case 'authorurl': return embedSetAuthorField(message, args, 'url');
    case 'url': return embedSetUrl(message, args);
    case 'timestamp': return embedToggleTimestamp(message, args);
    case 'addfield': return embedAddField(message, args, false);
    case 'addinlinefield': return embedAddField(message, args, true);
    case 'clearfields': return embedClearFields(message, args);
    case 'preview': return embedPreview(message, args);
    case 'send': return embedSend(message, args);
    case 'edit': return embedEdit(message, args);
    case 'list': return embedList(message);
    case 'delete': return embedDelete(message, args);
    case 'clone': return embedClone(message, args);
    case 'info': return embedInfo(message, args);
    default: return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`embed ${sub}\` n'existe pas.`)] });
  }
}

async function embedCreate(message, args) {
  const id = args[0];
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  if (getEmbed(message.guild.id, id)) return message.reply({ embeds: [errorEmbed('Erreur', `L'embed \`${id}\` existe déjà.`)] });
  saveEmbed(message.guild.id, id, defaultEmbedData());
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed créé', `Embed \`${id}\` créé avec succès.`)] });
}

async function embedSetField(message, args, field) {
  const id = args.shift();
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  const value = args.join(' ');
  if (!value) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une valeur.')] });
  data[field] = value;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `**${field}** de \`${id}\` mis à jour.`)] });
}

async function embedSetColor(message, args) {
  const id = args[0];
  const hex = args[1];
  if (!id || !hex) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `embed color <id> <#HEX>`')] });
  if (!isValidHex(hex)) return message.reply({ embeds: [errorEmbed('Couleur invalide', 'Format: `#RRGGBB`')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.color = hex;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Couleur de \`${id}\` mise à jour: \`${hex}\``)] });
}

async function embedSetImage(message, args) {
  const id = args[0]; const url = args.slice(1).join(' ');
  if (!id || !url) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `embed image <id> <url>`')] });
  if (!isValidUrl(url)) return message.reply({ embeds: [errorEmbed('URL invalide', 'URL invalide.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.image = url;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Image de \`${id}\` mise à jour.`)] });
}

async function embedSetThumbnail(message, args) {
  const id = args[0]; const url = args.slice(1).join(' ');
  if (!id || !url) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `embed thumbnail <id> <url>`')] });
  if (!isValidUrl(url)) return message.reply({ embeds: [errorEmbed('URL invalide', 'URL invalide.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.thumbnail = url;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Miniature de \`${id}\` mise à jour.`)] });
}

async function embedSetFooter(message, args) {
  const id = args.shift();
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.footer.text = args.join(' ');
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Footer de \`${id}\` mis à jour.`)] });
}

async function embedSetFooterIcon(message, args) {
  const id = args[0]; const url = args.slice(1).join(' ');
  if (!id || !url) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `embed footericon <id> <url>`')] });
  if (!isValidUrl(url)) return message.reply({ embeds: [errorEmbed('URL invalide', 'URL invalide.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.footer.iconUrl = url;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Icône du footer de \`${id}\` mise à jour.`)] });
}

async function embedSetAuthorField(message, args, field) {
  const id = args.shift();
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  const value = args.join(' ');
  data.author[field] = value;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Auteur (\`${field}\`) de \`${id}\` mis à jour.`)] });
}

async function embedSetUrl(message, args) {
  const id = args[0]; const url = args.slice(1).join(' ');
  if (!id || !url) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `embed url <id> <url>`')] });
  if (!isValidUrl(url)) return message.reply({ embeds: [errorEmbed('URL invalide', 'URL invalide.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.url = url;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `URL de \`${id}\` mise à jour.`)] });
}

async function embedToggleTimestamp(message, args) {
  const id = args[0];
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.timestamp = !data.timestamp;
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Timestamp de \`${id}\`: \`${data.timestamp}\``)] });
}

async function embedAddField(message, args, inline) {
  const id = args.shift();
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  const rest = args.join(' ');
  const parts = rest.split('|');
  if (parts.length < 2) return message.reply({ embeds: [errorEmbed('Erreur', 'Séparateur `|` manquant.')] });
  if (data.fields.length >= 25) return message.reply({ embeds: [errorEmbed('Erreur', 'Maximum 25 champs par embed.')] });
  data.fields.push({ name: parts[0].trim(), value: parts.slice(1).join('|').trim(), inline });
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Champ ajouté', `Champ ajouté à \`${id}\`.`)] });
}

async function embedClearFields(message, args) {
  const id = args[0];
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  data.fields = [];
  saveEmbed(message.guild.id, id, data);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Champs supprimés', `Tous les champs de \`${id}\` ont été supprimés.`)] });
}

async function embedPreview(message, args) {
  const id = args[0];
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  await message.channel.send({ content: `📋 Prévisualisation de \`${id}\`:`, embeds: [buildEmbed(data, message.guild.id)] });
}

async function embedSend(message, args) {
  const id = args[0];
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  const target = message.mentions.channels.first() || message.channel;
  await target.send({ embeds: [buildEmbed(data, message.guild.id)] });
  if (target.id !== message.channel.id) {
    await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed envoyé', `Embed \`${id}\` envoyé dans ${target}.`)] });
  }
}

async function embedEdit(message, args) {
  const id = args[0];
  const msgId = args[1];
  if (!id || !msgId) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `embed edit <id> <msg_id> [#salon]`')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  const channel = message.mentions.channels.first() || message.channel;
  try {
    const targetMsg = await channel.messages.fetch(msgId);
    await targetMsg.edit({ embeds: [buildEmbed(data, message.guild.id)] });
    await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed modifié', `Message édité avec \`${id}\`.`)] });
  } catch {
    await message.reply({ embeds: [errorEmbed('Erreur', 'Message introuvable.')] });
  }
}

async function embedList(message) {
  const rows = db.prepare('SELECT embed_id, created_at FROM embeds WHERE guild_id = ?').all(message.guild.id);
  if (!rows.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Embeds', 'Aucun embed créé.')] });
  const items = rows.map((r, i) => `\`${i + 1}.\` **${r.embed_id}** — <t:${r.created_at}:R>`);
  const { items: pageItems } = paginate(items, 0, 20);
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`📝 Embeds du serveur (${rows.length})`)
    .setDescription(pageItems.join('\n'));
  await message.reply({ embeds: [embed] });
}

async function embedDelete(message, args) {
  const id = args[0];
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  db.prepare('DELETE FROM embeds WHERE guild_id = ? AND embed_id = ?').run(message.guild.id, id);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed supprimé', `Embed \`${id}\` supprimé.`)] });
}

async function embedClone(message, args) {
  const id = args[0]; const newId = args[1];
  if (!id || !newId) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `embed clone <id> <nouvel_id>`')] });
  const data = getEmbed(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  if (getEmbed(message.guild.id, newId)) return message.reply({ embeds: [errorEmbed('Erreur', `L'embed \`${newId}\` existe déjà.`)] });
  saveEmbed(message.guild.id, newId, { ...data });
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Embed cloné', `\`${id}\` → \`${newId}\``)] });
}

async function embedInfo(message, args) {
  const id = args[0];
  if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
  const row = db.prepare('SELECT * FROM embeds WHERE guild_id = ? AND embed_id = ?').get(message.guild.id, id);
  if (!row) return message.reply({ embeds: [errorEmbed('Erreur', `Embed \`${id}\` introuvable.`)] });
  const data = JSON.parse(row.data);
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`📋 Info — \`${id}\``)
    .addFields(
      { name: 'Titre', value: data.title || '*(vide)*', inline: true },
      { name: 'Couleur', value: data.color || '*(défaut)*', inline: true },
      { name: 'Timestamp', value: data.timestamp ? '✅' : '❌', inline: true },
      { name: 'Image', value: data.image ? '✅' : '❌', inline: true },
      { name: 'Thumbnail', value: data.thumbnail ? '✅' : '❌', inline: true },
      { name: 'Champs', value: `\`${data.fields.length}\``, inline: true },
      { name: 'Créé le', value: `<t:${row.created_at}:F>`, inline: false }
    );
  await message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SYSTÈME D'ANNONCES
// ═══════════════════════════════════════════════════════════════════════════════

const defaultAnnounceData = () => ({
  title: '', description: '', color: null, image: null, thumbnail: null,
  footer: { text: '', iconUrl: '' }, timestamp: false,
  content: '', buttons: [], fields: []
});

function getAnnounce(guildId, announceId) {
  const row = db.prepare('SELECT data FROM announces WHERE guild_id = ? AND announce_id = ?').get(guildId, announceId);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function saveAnnounce(guildId, announceId, data) {
  db.prepare('INSERT OR REPLACE INTO announces (guild_id, announce_id, data) VALUES (?, ?, ?)').run(guildId, announceId, JSON.stringify(data));
}

async function cmdAnnounce(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });

  const id = args[0];

  switch (sub.toLowerCase()) {
    case 'create': {
      if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
      if (getAnnounce(message.guild.id, id)) return message.reply({ embeds: [errorEmbed('Erreur', `L'annonce \`${id}\` existe déjà.`)] });
      saveAnnounce(message.guild.id, id, defaultAnnounceData());
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce créée', `Annonce \`${id}\` créée.`)] });
    }
    case 'title': {
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      data.title = args.slice(1).join(' ');
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Titre mis à jour.`)] });
    }
case 'description': {
  const data = getAnnounce(message.guild.id, id);

  if (!data) {
    return message.reply({
      embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)]
    });
  }

  // 🔥 récupère TOUT le texte après "announce description id"
  const description = message.content
    .split(' ')
    .slice(3)
    .join(' ');

  data.description = description;

  saveAnnounce(message.guild.id, id, data);

  return message.reply({
    embeds: [
      successEmbed(
        message.guild.id,
        'Annonce',
        'Description mise à jour.'
      )
    ]
  });
}
    case 'color': {
      const hex = args[1];
      if (!isValidHex(hex)) return message.reply({ embeds: [errorEmbed('Couleur invalide', 'Format: `#RRGGBB`')] });
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      data.color = hex;
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Couleur: \`${hex}\``)] });
    }
    case 'image': {
      const url = args.slice(1).join(' ');
      if (!isValidUrl(url)) return message.reply({ embeds: [errorEmbed('URL invalide', 'URL invalide.')] });
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      data.image = url;
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Image mise à jour.`)] });
    }
    case 'thumbnail': {
      const url = args.slice(1).join(' ');
      if (!isValidUrl(url)) return message.reply({ embeds: [errorEmbed('URL invalide', 'URL invalide.')] });
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      data.thumbnail = url;
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Miniature mise à jour.`)] });
    }
    case 'footer': {
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      data.footer.text = args.slice(1).join(' ');
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Footer mis à jour.`)] });
    }
    case 'timestamp': {
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      data.timestamp = !data.timestamp;
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Timestamp: \`${data.timestamp}\``)] });
    }
    case 'addbutton': {
      const btnId = args[1];
      if (!btnId) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID de bouton.')] });
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      if (!data.buttons.includes(btnId)) data.buttons.push(btnId);
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Bouton \`${btnId}\` ajouté.`)] });
    }
    case 'removebutton': {
      const btnId = args[1];
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      data.buttons = data.buttons.filter(b => b !== btnId);
      saveAnnounce(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce', `Bouton \`${btnId}\` retiré.`)] });
    }
    case 'content': {
  const data = getAnnounce(message.guild.id, id);

  if (!data) {
    return message.reply({
      embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)]
    });
  }

  let content = args.slice(1).join(' ');
  content = content.replace(/\\n/g, '\n');

  data.content = content;

  saveAnnounce(message.guild.id, id, data);

  return message.reply({
    embeds: [
      successEmbed(
        message.guild.id,
        'Annonce',
        'Contenu mis à jour.'
      )
    ]
  });
}
data.fields.push({
  name: parts[0].trim().replace(/\\n/g, '\n'),
  value: parts.slice(1).join('|').trim().replace(/\\n/g, '\n'),
  inline: false
});
    case 'preview': {
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      const rows = buildActionRows(message.guild.id, data.buttons);
      await message.channel.send({ content: data.content || undefined, embeds: [buildEmbed(data, message.guild.id)], components: rows });
      break;
    }
    case 'send': {
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      const target = message.mentions.channels.first() || message.channel;
      const rows = buildActionRows(message.guild.id, data.buttons);
      await target.send({ content: data.content || undefined, embeds: [buildEmbed(data, message.guild.id)], components: rows });
      if (target.id !== message.channel.id) await message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce envoyée', `Annonce envoyée dans ${target}.`)] });
      break;
    }
    case 'edit': {
      const msgId = args[1];
      if (!id || !msgId) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `announce edit <id> <msg_id> [#salon]`')] });
      const data = getAnnounce(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      const channel = message.mentions.channels.first() || message.channel;
      try {
        const targetMsg = await channel.messages.fetch(msgId);
        const rows = buildActionRows(message.guild.id, data.buttons);
        await targetMsg.edit({ content: data.content || null, embeds: [buildEmbed(data, message.guild.id)], components: rows });
        await message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce modifiée', `Message édité.`)] });
      } catch {
        await message.reply({ embeds: [errorEmbed('Erreur', 'Message introuvable.')] });
      }
      break;
    }
    case 'addfield': {
  const data = getAnnounce(message.guild.id, id);

  if (!data) {
    return message.reply({
      embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)]
    });
  }

  const raw = args.slice(1).join(' ');

  const separatorIndex = raw.indexOf('|');

  if (separatorIndex === -1) {
    return message.reply({
      embeds: [
        errorEmbed(
          'Erreur',
          'Format : `~announce addfield <id> Nom du champ | Valeur du champ`'
        )
      ]
    });
  }

  let name = raw.slice(0, separatorIndex).trim();
  let value = raw.slice(separatorIndex + 1).trim();

  name = name.replace(/\\n/g, '\n');
  value = value.replace(/\\n/g, '\n');

  if (!name.length) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'Le nom du champ ne peut pas être vide.')]
    });
  }

  if (!value.length) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'La valeur du champ ne peut pas être vide.')]
    });
  }

  if (name.length > 256) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'Le nom du champ dépasse 256 caractères.')]
    });
  }

  if (value.length > 1024) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'La valeur du champ dépasse 1024 caractères.')]
    });
  }

  if (data.fields.length >= 25) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'Maximum 25 champs par embed.')]
    });
  }

  data.fields.push({
    name,
    value,
    inline: false
  });

  saveAnnounce(message.guild.id, id, data);

  return message.reply({
    embeds: [
      successEmbed(
        message.guild.id,
        'Champ ajouté',
        `Le champ **${name}** a été ajouté.`
      )
    ]
  });
}
case 'addinlinefield': {
  const data = getAnnounce(message.guild.id, id);

  if (!data) {
    return message.reply({
      embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)]
    });
  }

  const raw = args.slice(1).join(' ');

  const separatorIndex = raw.indexOf('|');

  if (separatorIndex === -1) {
    return message.reply({
      embeds: [
        errorEmbed(
          'Erreur',
          'Format : `~announce addinlinefield <id> Nom du champ | Valeur du champ`'
        )
      ]
    });
  }

  let name = raw.slice(0, separatorIndex).trim();
  let value = raw.slice(separatorIndex + 1).trim();

  name = name.replace(/\\n/g, '\n');
  value = value.replace(/\\n/g, '\n');

  if (!name.length) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'Le nom du champ ne peut pas être vide.')]
    });
  }

  if (!value.length) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'La valeur du champ ne peut pas être vide.')]
    });
  }

  if (name.length > 256) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'Le nom du champ dépasse 256 caractères.')]
    });
  }

  if (value.length > 1024) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'La valeur du champ dépasse 1024 caractères.')]
    });
  }

  if (data.fields.length >= 25) {
    return message.reply({
      embeds: [errorEmbed('Erreur', 'Maximum 25 champs par embed.')]
    });
  }

  data.fields.push({
    name,
    value,
    inline: true
  });

  saveAnnounce(message.guild.id, id, data);

  return message.reply({
    embeds: [
      successEmbed(
        message.guild.id,
        'Champ inline ajouté',
        `Le champ **${name}** a été ajouté.`
      )
    ]
  });
}
    case 'list': {
      const rows = db.prepare('SELECT announce_id, created_at FROM announces WHERE guild_id = ?').all(message.guild.id);
      if (!rows.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Annonces', 'Aucune annonce.')] });
      const items = rows.map((r, i) => `\`${i + 1}.\` **${r.announce_id}** — <t:${r.created_at}:R>`);
      return message.reply({ embeds: [new EmbedBuilder().setColor(getDefaultColor(message.guild.id)).setTitle(`📢 Annonces (${rows.length})`).setDescription(items.join('\n'))] });
    }
    case 'delete': {
      if (!getAnnounce(message.guild.id, id)) return message.reply({ embeds: [errorEmbed('Erreur', `Annonce \`${id}\` introuvable.`)] });
      db.prepare('DELETE FROM announces WHERE guild_id = ? AND announce_id = ?').run(message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Annonce supprimée', `Annonce \`${id}\` supprimée.`)] });
    }
    default:
      return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`announce ${sub}\` n'existe pas.`)] });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SYSTÈME DE BOUTONS
// ═══════════════════════════════════════════════════════════════════════════════

const defaultButtonData = () => ({
  label: 'Bouton', style: 'primary', emoji: null, disabled: false,
  action: 'message', target: null, responseMessage: null,
  responseEmbed: null, ephemeral: true
});

function getButton(guildId, buttonId) {
  const row = db.prepare('SELECT data FROM buttons WHERE guild_id = ? AND button_id = ?').get(guildId, buttonId);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function saveButton(guildId, buttonId, data) {
  db.prepare('INSERT OR REPLACE INTO buttons (guild_id, button_id, data) VALUES (?, ?, ?)').run(guildId, buttonId, JSON.stringify(data));
}

async function cmdButton(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });
  const id = args[0];

  switch (sub.toLowerCase()) {
    case 'create': {
      const label = args.slice(1).join(' ') || 'Bouton';
      if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
      if (getButton(message.guild.id, id)) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` existe déjà.`)] });
      const data = defaultButtonData();
      data.label = label;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton créé', `Bouton \`${id}\` créé.`)] });
    }
    case 'label': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.label = args.slice(1).join(' ');
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Label mis à jour.`)] });
    }
    case 'style': {
      const style = args[1]?.toLowerCase();
      if (!['primary', 'secondary', 'success', 'danger'].includes(style)) {
        return message.reply({ embeds: [errorEmbed('Erreur', 'Styles: `primary`, `secondary`, `success`, `danger`')] });
      }
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.style = style;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Style: \`${style}\``)] });
    }
    case 'emoji': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.emoji = args[1] || null;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Emoji: \`${args[1] || 'aucun'}\``)] });
    }
    case 'action': {
      const action = args[1]?.toLowerCase();
      const validActions = ['message', 'embed', 'role', 'ticket', 'access', 'invite', 'dm'];
      if (!validActions.includes(action)) return message.reply({ embeds: [errorEmbed('Erreur', `Actions: ${validActions.map(a => `\`${a}\``).join(', ')}`)] });
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.action = action;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Action: \`${action}\``)] });
    }
    case 'ticketcategory': {
  const data = getButton(message.guild.id, id);
  if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });

  const categoryId = args[1];
  if (!categoryId) {
    data.ticketCategoryId = null;
  } else {
    const category = message.guild.channels.cache.get(categoryId);
    if (!category || category.type !== 4) {
      return message.reply({ embeds: [errorEmbed('Erreur', 'Catégorie invalide.')] });
    }
    data.ticketCategoryId = categoryId;
  }

  saveButton(message.guild.id, id, data);

  return message.reply({
    embeds: [successEmbed(message.guild.id, 'Ticket', `Catégorie définie: \`${categoryId || 'aucune'}\``)]
  });
}
    case 'settarget': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.target = args[1] || null;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Cible: \`${args[1] || 'aucune'}\``)] });
    }
    case 'setmessage': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.responseMessage = args.slice(1).join(' ');
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Message de réponse mis à jour.`)] });
    }
    case 'setembed': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.responseEmbed = args[1] || null;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Embed de réponse: \`${args[1] || 'aucun'}\``)] });
    }
    case 'ephemeral': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.ephemeral = args[1] !== 'false';
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Éphémère: \`${data.ephemeral}\``)] });
    }
    case 'disable': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.disabled = true;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Bouton \`${id}\` désactivé.`)] });
    }
    case 'enable': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      data.disabled = false;
      saveButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton', `Bouton \`${id}\` activé.`)] });
    }
    case 'list': {
      const rows = db.prepare('SELECT button_id, data FROM buttons WHERE guild_id = ?').all(message.guild.id);
      if (!rows.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Boutons', 'Aucun bouton.')] });
      const items = rows.map(r => {
        const d = JSON.parse(r.data);
        return `\`${r.button_id}\` — ${d.label} | Action: \`${d.action}\` | Style: \`${d.style}\``;
      });
      return message.reply({ embeds: [new EmbedBuilder().setColor(getDefaultColor(message.guild.id)).setTitle(`🔘 Boutons (${rows.length})`).setDescription(items.join('\n'))] });
    }
    case 'delete': {
      if (!getButton(message.guild.id, id)) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      db.prepare('DELETE FROM buttons WHERE guild_id = ? AND button_id = ?').run(message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Bouton supprimé', `Bouton \`${id}\` supprimé.`)] });
    }
    case 'info': {
      const data = getButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton \`${id}\` introuvable.`)] });
      const embed = new EmbedBuilder()
        .setColor(getDefaultColor(message.guild.id))
        .setTitle(`🔘 Info — \`${id}\``)
        .addFields(
          { name: 'Label', value: data.label, inline: true },
          { name: 'Style', value: data.style, inline: true },
          { name: 'Emoji', value: data.emoji || 'Aucun', inline: true },
          { name: 'Action', value: data.action, inline: true },
          { name: 'Cible', value: data.target || 'Aucune', inline: true },
          { name: 'Éphémère', value: data.ephemeral ? '✅' : '❌', inline: true },
          { name: 'Désactivé', value: data.disabled ? '✅' : '❌', inline: true }
        );
      return message.reply({ embeds: [embed] });
    }
    default:
      return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`button ${sub}\` n'existe pas.`)] });
  }
}

/**
 * Handle button click interactions
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleButtonInteraction(interaction) {
  const id = interaction.customId;

  try {
    if (id === 'ticket_open') {
      return await openTicket(interaction);
    }

    if (id === 'ticket_close') {
      return await handleTicketClose(interaction);
    }

    if (id === 'ticket_claim') {
      return await ticketClaimFromButton(interaction);
    }

    if (id.startsWith('poll_')) {
      return handlePollVote(interaction);
    }

    if (id.startsWith('auth_')) {
      return handleAuthButton(interaction);
    }

    if (id.startsWith('btn_')) {
      const btnId = id.slice(4);
      const guildId = interaction.guild.id;

      const btnRow = db.prepare(
        'SELECT data FROM buttons WHERE guild_id = ? AND button_id = ?'
      ).get(guildId, btnId);

      if (btnRow) {
        const data = JSON.parse(btnRow.data);
        return handleRegularButtonAction(interaction, data, guildId);
      }
    }

  } catch (err) {
    console.error('Button handler error:', err);

    if (!interaction.replied) {
      await interaction.reply({
        content: '❌ Erreur bouton.',
        flags: 64
      }).catch(() => {});
    }
  }
}

/**
 * Handle a regular button action
 */
async function handleRegularButtonAction(interaction, data, guildId) {
  try {
    const ephemeral = data.ephemeral !== false;
    switch (data.action) {
      case 'message': {
        if (!data.responseMessage) return interaction.reply({ content: '❌ Aucun message configuré.', ephemeral: true });
        return interaction.reply({ content: data.responseMessage, ephemeral });
      }
      case 'embed': {
        if (!data.responseEmbed) return interaction.reply({ content: '❌ Aucun embed configuré.', ephemeral: true });
        const embedData = getEmbed(guildId, data.responseEmbed);
        if (!embedData) return interaction.reply({ content: '❌ Embed introuvable.', ephemeral: true });
        return interaction.reply({ embeds: [buildEmbed(embedData, guildId)], ephemeral });
      }
      case 'role': {
        const roleId = data.target;
        if (!roleId) return interaction.reply({ content: '❌ Rôle non configuré.', ephemeral: true });
        const member = interaction.member;
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) return interaction.reply({ content: '❌ Rôle introuvable.', ephemeral: true });
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(role);
          return interaction.reply({ content: `✅ Rôle ${role.name} retiré.`, ephemeral });
        } else {
          await member.roles.add(role);
          return interaction.reply({ content: `✅ Rôle ${role.name} attribué.`, ephemeral });
        }
      }
      case 'ticket': {
        return openTicket(interaction, data.ticketCategoryId);
      }
      case 'access': {
        const accessRow = db.prepare('SELECT data FROM access WHERE guild_id = ? AND access_id = ?').get(guildId, data.target);
        if (!accessRow) return interaction.reply({ content: '❌ Accès introuvable.', ephemeral: true });
        const accessData = JSON.parse(accessRow.data);
        return handleAccessGrant(interaction, accessData);
      }
      case 'invite': {
        const inviteUrl = data.target;
        if (!inviteUrl) return interaction.reply({ content: '❌ Lien d\'invitation non configuré.', ephemeral: true });
        try {
          await interaction.user.send(`🔗 Voici votre lien d'invitation: ${inviteUrl}`);
          return interaction.reply({ content: '✅ Lien envoyé en DM!', ephemeral: true });
        } catch {
          return interaction.reply({ content: `🔗 ${inviteUrl}`, ephemeral: true });
        }
      }
      case 'dm': {
        if (!data.responseMessage) return interaction.reply({ content: '❌ Aucun message configuré.', ephemeral: true });
        try {
          await interaction.user.send(data.responseMessage);
          return interaction.reply({ content: '✅ Message envoyé en DM!', ephemeral: true });
        } catch {
          return interaction.reply({ content: '❌ Impossible d\'envoyer un DM.', ephemeral: true });
        }
      }
      default:
        return interaction.reply({ content: '❌ Action inconnue.', ephemeral: true });
    }
  } catch (err) {
    console.error('Button action error:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Erreur lors du traitement.', ephemeral: true });
    }
  }
}

// ─── Access Grant Handler ──────────────────────────────────────────────────

async function handleAccessGrant(interaction, accessData) {
  const member = interaction.member;
  const channel = interaction.guild.channels.cache.get(accessData.channelId);
  const role = accessData.roleId ? interaction.guild.roles.cache.get(accessData.roleId) : null;

  let msg = '';

  if (role) {
    if (accessData.type === 'toggle' && member.roles.cache.has(accessData.roleId)) {
      await member.roles.remove(role);
      msg += `Rôle **${role.name}** retiré. `;
    } else if (!member.roles.cache.has(accessData.roleId)) {
      await member.roles.add(role);
      msg += `Rôle **${role.name}** attribué. `;
    }
  }

  if (channel) {
    await channel.permissionOverwrites.edit(member, { ViewChannel: true, SendMessages: true });
    msg += `Accès à ${channel} accordé.`;
  }

  await interaction.reply({ content: `✅ ${msg}`, ephemeral: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SYSTÈME D'AUTH OAUTH2
// ═══════════════════════════════════════════════════════════════════════════════

const defaultAuthButtonData = () => ({
  label: '✅ S\'authentifier', style: 'success', emoji: null, disabled: false,
  targetGuildId: null, targetGuildInvite: null,
  successMessage: '✅ Tu as bien été ajouté au serveur !',
  errorMessage: '❌ Une erreur est survenue.',
  alreadyMessage: 'ℹ️ Tu es déjà membre du serveur.',
  dmOnSuccess: true, logChannel: null, ephemeral: true,
  requireRole: null, botToken: null
});

function getAuthButton(guildId, buttonId) {
  const row = db.prepare('SELECT data FROM auth_buttons WHERE guild_id = ? AND button_id = ?').get(guildId, buttonId);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function saveAuthButton(guildId, buttonId, data) {
  db.prepare('INSERT OR REPLACE INTO auth_buttons (guild_id, button_id, data) VALUES (?, ?, ?)').run(guildId, buttonId, JSON.stringify(data));
}

async function cmdAuth(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });
  const id = args[0];

  switch (sub.toLowerCase()) {
    case 'create': {
      const label = args.slice(1).join(' ') || '✅ S\'authentifier';
      if (!id) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID.')] });
      if (getAuthButton(message.guild.id, id)) return message.reply({ embeds: [errorEmbed('Erreur', `Bouton auth \`${id}\` existe déjà.`)] });
      const data = defaultAuthButtonData();
      data.label = label;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth créé', `Bouton auth \`${id}\` créé.`)] });
    }
    case 'label': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.label = args.slice(1).join(' ');
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Label mis à jour.`)] });
    }
    case 'style': {
      const style = args[1]?.toLowerCase();
      if (!['primary', 'secondary', 'success', 'danger'].includes(style)) return message.reply({ embeds: [errorEmbed('Erreur', 'Styles valides: primary, secondary, success, danger')] });
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.style = style;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Style: \`${style}\``)] });
    }
    case 'emoji': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.emoji = args[1] || null;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Emoji mis à jour.`)] });
    }
    case 'setguild': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.targetGuildId = args[1] || null;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Serveur cible: \`${args[1] || 'aucun'}\``)] });
    }
    case 'setinvite': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.targetGuildInvite = args[1] || null;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Lien de secours: \`${args[1] || 'aucun'}\``)] });
    }
    case 'setsuccess': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.successMessage = args.slice(1).join(' ');
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Message succès mis à jour.`)] });
    }
    case 'seterror': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.errorMessage = args.slice(1).join(' ');
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Message erreur mis à jour.`)] });
    }
    case 'setalready': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.alreadyMessage = args.slice(1).join(' ');
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Message "déjà membre" mis à jour.`)] });
    }
    case 'setdm': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.dmOnSuccess = args[1] !== 'false';
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `DM succès: \`${data.dmOnSuccess}\``)] });
    }
    case 'setlog': {
      const channel = message.mentions.channels.first();
      if (!channel) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un salon.')] });
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.logChannel = channel.id;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Salon de log: ${channel}`)] });
    }
    case 'setrequirerole': {
      const role = message.mentions.roles.first();
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.requireRole = role ? role.id : null;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Rôle requis: ${role || 'aucun'}`)] });
    }
    case 'ephemeral': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.ephemeral = args[1] !== 'false';
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Éphémère: \`${data.ephemeral}\``)] });
    }
    case 'settoken': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.botToken = args[1] || null;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Token mis à jour.`)] });
    }
    case 'disable': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.disabled = true;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Bouton désactivé.`)] });
    }
    case 'enable': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      data.disabled = false;
      saveAuthButton(message.guild.id, id, data);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth', `Bouton activé.`)] });
    }
    case 'list': {
      const rows = db.prepare('SELECT button_id FROM auth_buttons WHERE guild_id = ?').all(message.guild.id);
      if (!rows.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Auth Buttons', 'Aucun bouton d\'auth.')] });
      const items = rows.map(r => `• \`${r.button_id}\``);
      return message.reply({ embeds: [new EmbedBuilder().setColor(getDefaultColor(message.guild.id)).setTitle('🔐 Boutons Auth').setDescription(items.join('\n'))] });
    }
    case 'delete': {
      if (!getAuthButton(message.guild.id, id)) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      db.prepare('DELETE FROM auth_buttons WHERE guild_id = ? AND button_id = ?').run(message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Auth supprimé', `Auth \`${id}\` supprimé.`)] });
    }
    case 'info': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      const embed = new EmbedBuilder()
        .setColor(getDefaultColor(message.guild.id))
        .setTitle(`🔐 Auth Info — \`${id}\``)
        .addFields(
          { name: 'Label', value: data.label, inline: true },
          { name: 'Style', value: data.style, inline: true },
          { name: 'Serveur cible', value: data.targetGuildId || 'Non défini', inline: true },
          { name: 'DM succès', value: data.dmOnSuccess ? '✅' : '❌', inline: true },
          { name: 'Éphémère', value: data.ephemeral ? '✅' : '❌', inline: true },
          { name: 'Désactivé', value: data.disabled ? '✅' : '❌', inline: true },
          { name: 'Message succès', value: data.successMessage, inline: false },
          { name: 'Message erreur', value: data.errorMessage, inline: false }
        );
      return message.reply({ embeds: [embed] });
    }
    case 'preview': {
      const data = getAuthButton(message.guild.id, id);
      if (!data) return message.reply({ embeds: [errorEmbed('Erreur', `Auth \`${id}\` introuvable.`)] });
      const styleMap = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
      const btn = new ButtonBuilder()
        .setCustomId(`auth_${id}`)
        .setLabel(data.label)
        .setStyle(styleMap[data.style] || ButtonStyle.Success)
        .setDisabled(!!data.disabled);
      if (data.emoji) { try { btn.setEmoji(data.emoji); } catch {} }
      const row = new ActionRowBuilder().addComponents(btn);
      return message.channel.send({ content: '🔐 Prévisualisation du bouton auth:', components: [row] });
    }
    default:
      return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`auth ${sub}\` n'existe pas.`)] });
  }
}

/**
 * Handle auth button click: generate OAuth2 URL and send ephemeral link
 */
async function handleAuthButtonClick(interaction, btnId, data) {
  try {
    if (data.disabled) return interaction.reply({ content: '❌ Ce bouton est désactivé.', ephemeral: true });

    // Check required role
    if (data.requireRole) {
      if (!interaction.member.roles.cache.has(data.requireRole)) {
        return interaction.reply({ content: `❌ Vous devez avoir le rôle <@&${data.requireRole}> pour utiliser ce bouton.`, ephemeral: true });
      }
    }

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return interaction.reply({ content: '❌ OAuth2 non configuré (CLIENT_ID/CLIENT_SECRET manquants).', ephemeral: true });
    }

    // Generate state
    const state = generateUUID();
    oauthStates.set(state, {
      userId: interaction.user.id,
      guildId: interaction.guild.id,
      authButtonId: btnId,
      expires: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    // Build OAuth2 URL
    const oauthUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join&state=${state}`;

    const linkBtn = new ButtonBuilder()
      .setLabel('🔗 Cliquer ici pour s\'authentifier')
      .setStyle(ButtonStyle.Link)
      .setURL(oauthUrl);

    const row = new ActionRowBuilder().addComponents(linkBtn);
    await interaction.reply({
      content: '🔐 Cliquez sur le bouton ci-dessous pour vous authentifier via Discord OAuth2.',
      components: [row],
      ephemeral: data.ephemeral !== false
    });
  } catch (err) {
    console.error('Auth button click error:', err);
    if (!interaction.replied) await interaction.reply({ content: '❌ Erreur lors du traitement.', ephemeral: true });
  }
}

/**
 * Handle the auth button in the button interaction handler
 */
async function handleAuthButton(interaction) {
  const btnId = interaction.customId.slice(5); // Remove 'auth_'
  const guildId = interaction.guild.id;
  const authRow = db.prepare('SELECT data FROM auth_buttons WHERE guild_id = ? AND button_id = ?').get(guildId, btnId);
  if (!authRow) return interaction.reply({ content: '❌ Bouton auth introuvable.', ephemeral: true });
  const data = JSON.parse(authRow.data);
  return handleAuthButtonClick(interaction, btnId, data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SERVEUR HTTP (CALLBACK OAUTH2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate success HTML page
 */
function htmlSuccess(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Authentification réussie</title>
<style>
  body { background: #23272a; color: #fff; font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #2c2f33; border-radius: 12px; padding: 40px; text-align: center; max-width: 400px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  .icon { font-size: 60px; margin-bottom: 16px; }
  h1 { color: #57f287; margin: 0 0 12px; }
  p { color: #b9bbbe; margin: 0 0 20px; }
  .timer { font-size: 13px; color: #72767d; }
</style>
<script>let s=5;const t=setInterval(()=>{document.getElementById('c').textContent=--s;if(s<=0){clearInterval(t);window.close();}},1000);</script>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>Authentification réussie !</h1>
  <p>${message}</p>
  <div class="timer">Cette page se ferme dans <span id="c">5</span> secondes...</div>
</div>
</body></html>`;
}

/**
 * Generate error HTML page
 */
function htmlError(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Erreur d'authentification</title>
<style>
  body { background: #23272a; color: #fff; font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #2c2f33; border-radius: 12px; padding: 40px; text-align: center; max-width: 400px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  .icon { font-size: 60px; margin-bottom: 16px; }
  h1 { color: #ed4245; margin: 0 0 12px; }
  p { color: #b9bbbe; margin: 0; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">❌</div>
  <h1>Erreur</h1>
  <p>${message}</p>
</div>
</body></html>`;
}

/**
 * Generate "already member" HTML page
 */
function htmlAlready(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Déjà membre</title>
<style>
  body { background: #23272a; color: #fff; font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #2c2f33; border-radius: 12px; padding: 40px; text-align: center; max-width: 400px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  .icon { font-size: 60px; margin-bottom: 16px; }
  h1 { color: #5865f2; margin: 0 0 12px; }
  p { color: #b9bbbe; margin: 0; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">ℹ️</div>
  <h1>Déjà membre</h1>
  <p>${message}</p>
</div>
</body></html>`;
}

/**
 * Start the HTTP server for OAuth2 callback
 */
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${HTTP_PORT}`);

    if (reqUrl.pathname === '/auth/callback') {
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlError('Paramètres manquants.'));
      }

      // Validate state
      const stateData = oauthStates.get(state);
      if (!stateData || stateData.expires < Date.now()) {
        oauthStates.delete(state);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlError('Lien expiré ou invalide. Veuillez réessayer.'));
      }
      oauthStates.delete(state);

      const { userId, guildId, authButtonId } = stateData;

      // Get auth button config
      const authRow = db.prepare('SELECT data FROM auth_buttons WHERE guild_id = ? AND button_id = ?').get(guildId, authButtonId);
      if (!authRow) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlError('Configuration introuvable.'));
      }
      const authData = JSON.parse(authRow.data);

      try {
        // Exchange code for access_token
        const tokenRes = await fetchJson('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
          }).toString()
        });

        if (!tokenRes.access_token) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(htmlError(authData.errorMessage || 'Erreur lors de l\'échange du token.'));
        }

        const accessToken = tokenRes.access_token;

        // Get user profile
        const userProfile = await fetchJson('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        const targetGuildId = authData.targetGuildId || guildId;
        const botToken = authData.botToken || TOKEN;

        // Check if user is already in the guild
        let alreadyMember = false;
        try {
          const memberCheck = await fetchJson(`https://discord.com/api/guilds/${targetGuildId}/members/${userProfile.id}`, {
            headers: { Authorization: `Bot ${botToken}` }
          });
          if (memberCheck.user) alreadyMember = true;
        } catch {}

        if (alreadyMember) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(htmlAlready(authData.alreadyMessage || 'Tu es déjà membre du serveur.'));
        }

        // Add user to guild via guilds.join
        const addRes = await rawFetch(`https://discord.com/api/guilds/${targetGuildId}/members/${userProfile.id}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ access_token: accessToken })
        });

        const isSuccess = addRes.status === 201 || addRes.status === 204;

        if (isSuccess) {
          // DM user on success
          if (authData.dmOnSuccess) {
            try {
              const dmChannel = await client.users.createDM(userProfile.id);
              await dmChannel.send(`✅ ${authData.successMessage}`);
            } catch {}
          }

          // Log to log channel
          if (authData.logChannel) {
            try {
              const guild = client.guilds.cache.get(guildId);
              if (guild) {
                const logCh = guild.channels.cache.get(authData.logChannel);
                if (logCh) {
                  const logEmbed = new EmbedBuilder()
                    .setColor('#57f287')
                    .setTitle('🔐 Authentification réussie')
                    .addFields(
                      { name: 'Utilisateur', value: `${userProfile.username}#${userProfile.discriminator} (\`${userProfile.id}\`)`, inline: true },
                      { name: 'Bouton', value: `\`${authButtonId}\``, inline: true },
                      { name: 'Serveur cible', value: `\`${targetGuildId}\``, inline: true }
                    )
                    .setTimestamp();
                  await logCh.send({ embeds: [logEmbed] });
                }
              }
            } catch {}
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(htmlSuccess(authData.successMessage || 'Tu as bien été ajouté au serveur !'));
        } else {
          // Try fallback invite
          if (authData.targetGuildInvite) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(htmlError(`${authData.errorMessage} <br><a href="${authData.targetGuildInvite}" style="color:#5865f2;">Rejoindre manuellement</a>`));
          }
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(htmlError(authData.errorMessage || 'Une erreur est survenue.'));
        }
      } catch (err) {
        console.error('OAuth2 callback error:', err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlError('Erreur interne du serveur.'));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(HTTP_PORT, () => {
    console.log(`🌐 HTTP Server running on port ${HTTP_PORT} (OAuth2 callback ready)`);
  });

  server.on('error', (err) => {
    console.error('HTTP Server error:', err.message);
  });
}

/**
 * Simple fetch helper using native http/https
 */
async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? require('https') : require('http');

    const reqOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Fetch helper that returns raw response with status
 */
async function rawFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = require('https');

    const reqOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SYSTÈME DE TICKETS
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdTicket(message, args) {
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });

  switch (sub.toLowerCase()) {
    case 'setup': return ticketSetup(message, args);
    case 'setcategory': return ticketSetCategory(message, args);
    case 'setlog': return ticketSetLog(message, args);
    case 'setsupport': return ticketSetSupport(message, args);
    case 'close': return ticketClose(message, args);
    case 'add': return ticketAdd(message, args);
    case 'remove': return ticketRemove(message, args);
    case 'rename': return ticketRename(message, args);
    case 'list': return ticketList(message);
    case 'panel': return ticketPanel(message, args);
    case 'claim': return ticketClaim(message);
    default: return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`ticket ${sub}\` n'existe pas.`)] });
  }
}

async function ticketSetup(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle('🎫 Configuration des Tickets')
    .setDescription('Utilisez les commandes suivantes pour configurer le système:')
    .addFields(
      { name: '`!ticket setcategory <#catégorie>`', value: 'Définit la catégorie des tickets', inline: false },
      { name: '`!ticket setlog <#salon>`', value: 'Définit le salon de logs', inline: false },
      { name: '`!ticket setsupport <@role>`', value: 'Définit le rôle de support', inline: false },
      { name: '`!ticket panel [#salon]`', value: 'Crée le panel de tickets', inline: false }
    );
  await message.reply({ embeds: [embed] });
}

async function ticketSetCategory(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
  if (!channel || channel.type !== ChannelType.GuildCategory) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez une catégorie valide.')] });
  db.prepare('INSERT OR REPLACE INTO ticket_config (guild_id, category_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET category_id=excluded.category_id').run(message.guild.id, channel.id);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Tickets', `Catégorie: **${channel.name}**`)] });
}

async function ticketSetLog(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const channel = message.mentions.channels.first();
  if (!channel) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un salon.')] });
  const existing = db.prepare('SELECT guild_id FROM ticket_config WHERE guild_id = ?').get(message.guild.id);
  if (existing) {
    db.prepare('UPDATE ticket_config SET log_channel_id = ? WHERE guild_id = ?').run(channel.id, message.guild.id);
  } else {
    db.prepare('INSERT INTO ticket_config (guild_id, log_channel_id) VALUES (?, ?)').run(message.guild.id, channel.id);
  }
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Tickets', `Salon de log: ${channel}`)] });
}

async function ticketSetSupport(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const role = message.mentions.roles.first();
  if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
  const existing = db.prepare('SELECT guild_id FROM ticket_config WHERE guild_id = ?').get(message.guild.id);
  if (existing) {
    db.prepare('UPDATE ticket_config SET support_role_id = ? WHERE guild_id = ?').run(role.id, message.guild.id);
  } else {
    db.prepare('INSERT INTO ticket_config (guild_id, support_role_id) VALUES (?, ?)').run(message.guild.id, role.id);
  }
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Tickets', `Rôle support: ${role}`)] });
}

async function ticketPanel(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const target = message.mentions.channels.first() || message.channel;
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle('🎫 Support — Ouvrir un Ticket')
    .setDescription('Cliquez sur le bouton ci-dessous pour ouvrir un ticket.\nNotre équipe de support vous répondra dès que possible.')
    .setTimestamp();

  const btn = new ButtonBuilder()
    .setCustomId('ticket_open')
    .setLabel('📩 Ouvrir un Ticket')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(btn);
  const panelMsg = await target.send({ embeds: [embed], components: [row] });

  const existing = db.prepare('SELECT guild_id FROM ticket_config WHERE guild_id = ?').get(message.guild.id);
  if (existing) {
    db.prepare('UPDATE ticket_config SET panel_message_id = ? WHERE guild_id = ?').run(panelMsg.id, message.guild.id);
  } else {
    db.prepare('INSERT INTO ticket_config (guild_id, panel_message_id) VALUES (?, ?)').run(message.guild.id, panelMsg.id);
  }

  if (target.id !== message.channel.id) {
    await message.reply({ embeds: [successEmbed(message.guild.id, 'Panel créé', `Panel de tickets créé dans ${target}.`)] });
  }
}

/**
 * Open a ticket from a button interaction
 */
async function openTicket(interaction, buttonCategoryId = null) {
  try {
    const guild = interaction.guild;
    const user = interaction.user;
    const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(guild.id);

    // Check if user already has a ticket
    const existing = db.prepare('SELECT ticket_channel_id FROM tickets WHERE guild_id = ? AND user_id = ? AND status = ?').get(guild.id, user.id, 'open');
    if (existing) {
      return interaction.reply({ content: `❌ Vous avez déjà un ticket ouvert: <#${existing.ticket_channel_id}>`, flags: 64 });
    }

    const categoryId = buttonCategoryId || config?.category_id;
    const supportRoleId = config?.support_role_id;

// Crée le ticket channel
const channelOptions = {
  name: `ticket-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
  type: ChannelType.GuildText,
};

if (categoryId) {
  // Mettre la catégorie
  channelOptions.parent = categoryId;

  // Hérite des permissions de la catégorie
  // Mais on ajoute quand même l'accès au créateur du ticket
  channelOptions.permissionOverwrites = [
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];
} else {
  // Pas de catégorie → permissions custom comme avant
  channelOptions.permissionOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
  ];

  if (supportRoleId) {
    channelOptions.permissionOverwrites.push({
      id: supportRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
  }
}

    if (categoryId) channelOptions.parent = categoryId;
    if (supportRoleId) {
      channelOptions.permissionOverwrites.push({
        id: supportRoleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      });
    }

const ticketChannel = await guild.channels.create({
  name: `ticket-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
  type: ChannelType.GuildText,
  parent: categoryId || null,

  permissionOverwrites: [
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },

    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },

    // rôle support
    ...(supportRoleId ? [{
      id: supportRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    }] : []),

    // rôle gérant (AJOUT ICI)
    {
      id: "1505993873200250891",
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    }
  ],
});
    // Save ticket to DB
    db.prepare('INSERT INTO tickets (guild_id, ticket_channel_id, user_id, status) VALUES (?, ?, ?, ?)').run(guild.id, ticketChannel.id, user.id, 'open');

    // ↓ AJOUTER ICI
    await triggerStatsRefresh(guild.id).catch(() => {});

    // Send welcome message in ticket
    const welcomeEmbed = new EmbedBuilder()
      .setColor(getDefaultColor(guild.id))
      .setTitle('🎫 Ticket ouvert')
      .setDescription(`Bonjour <@${user.id}>,\n\nVotre ticket a été créé. Notre équipe de support vous répondra dès que possible.\n\nPour fermer ce ticket, cliquez sur le bouton ci-dessous.`)
      .setTimestamp();

const claimBtn = new ButtonBuilder()
  .setCustomId('ticket_claim')
  .setLabel('📌 claim')
  .setStyle(ButtonStyle.Success);

const closeBtn = new ButtonBuilder()
  .setCustomId('ticket_close')
  .setLabel('🔒 close')
  .setStyle(ButtonStyle.Danger);

const row = new ActionRowBuilder().addComponents(claimBtn, closeBtn);
    await ticketChannel.send({
  content: `<@${user.id}>${supportRoleId ? ` | <@&${supportRoleId}>` : ''}`,
  embeds: [welcomeEmbed],
  components: [row]
});

    await interaction.reply({ content: `✅ Ticket créé: ${ticketChannel}`, ephemeral: true });
  } catch (err) {
    console.error('Open ticket error:', err);
    if (!interaction.replied) await interaction.reply({ content: '❌ Erreur lors de la création du ticket.', ephemeral: true });
  }
}

/**
 * Handle ticket close from button
 */
async function handleTicketClose(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;

  const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND ticket_channel_id = ?').get(guild.id, channel.id);
  if (!ticket) return interaction.reply({ content: '❌ Ce canal n\'est pas un ticket.', ephemeral: true });

  // Check permissions
  const member = interaction.member;
  if (ticket.user_id !== member.id && !isMod(member)) {
    return interaction.reply({ content: '❌ Vous ne pouvez pas fermer ce ticket.', ephemeral: true });
  }

  await interaction.reply({ content: '🔒 Fermeture du ticket en cours...', ephemeral: true });

  // Generate transcript
  const messages = await channel.messages.fetch({ limit: 100 });
  const transcript = generateTranscript(messages, channel.name, guild.name);

  // Update ticket status
  db.prepare('UPDATE tickets SET status = ? WHERE guild_id = ? AND ticket_channel_id = ?').run('closed', guild.id, channel.id);

  await triggerStatsRefresh(guild.id).catch(() => {});

  // Send transcript to log channel
  const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(guild.id);
  if (config?.log_channel_id) {
    const logChannel = guild.channels.cache.get(config.log_channel_id);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🎫 Ticket Fermé')
        .addFields(
          { name: 'Canal', value: channel.name, inline: true },
          { name: 'Utilisateur', value: `<@${ticket.user_id}>`, inline: true },
          { name: 'Fermé par', value: `<@${member.id}>`, inline: true },
          { name: 'Créé le', value: `<t:${ticket.created_at}:F>`, inline: false }
        )
        .setTimestamp();

      const transcriptBuffer = Buffer.from(transcript, 'utf-8');
      await logChannel.send({
        embeds: [logEmbed],
        files: [{ attachment: transcriptBuffer, name: `transcript-${channel.name}.html` }]
      });
    }
  }

  // DM transcript to user
  try {
    const ticketUser = await guild.members.fetch(ticket.user_id);
    const transcriptBuffer = Buffer.from(transcript, 'utf-8');
    await ticketUser.send({
      content: `📄 Voici le transcript de votre ticket **${channel.name}** :`,
      files: [{ attachment: transcriptBuffer, name: `transcript-${channel.name}.html` }]
    });
  } catch {}

  // Delete channel after 3 seconds
  setTimeout(() => channel.delete().catch(() => {}), 3000);
}

/**
 * Generate HTML transcript from messages
 */
function generateTranscript(messages, channelName, guildName) {
  const sortedMsgs = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const msgHtml = sortedMsgs.map(m => `
    <div class="msg">
      <img class="avatar" src="${m.author.displayAvatarURL()}" alt="avatar">
      <div class="content">
        <span class="author">${m.author.tag}</span>
        <span class="time">${new Date(m.createdTimestamp).toLocaleString('fr-FR')}</span>
        <div class="text">${m.content || '<em>(embed ou fichier)</em>'}</div>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Transcript — ${channelName}</title>
<style>
  body { background:#23272a;color:#dcddde;font-family:Arial,sans-serif;margin:0;padding:20px; }
  h1 { color:#fff; } h2 { color:#b9bbbe;font-size:14px; }
  .msg { display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #40444b; }
  .avatar { width:40px;height:40px;border-radius:50%; }
  .author { color:#fff;font-weight:bold;margin-right:8px; }
  .time { color:#72767d;font-size:12px; }
  .text { margin-top:4px; }
</style></head>
<body>
<h1>📄 Transcript — #${channelName}</h1>
<h2>Serveur: ${guildName} | Messages: ${sortedMsgs.length}</h2>
${msgHtml}
</body></html>`;
}

async function ticketClose(message, args) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND ticket_channel_id = ?').get(message.guild.id, message.channel.id);
  if (!ticket) return message.reply({ embeds: [errorEmbed('Erreur', 'Ce canal n\'est pas un ticket.')] });
  if (ticket.user_id !== message.author.id && !isMod(message.member)) {
    return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous ne pouvez pas fermer ce ticket.')] });
  }

  // Simulate button close
  const reason = args.join(' ') || 'Aucune raison';
  await message.reply({ embeds: [infoEmbed(message.guild.id, 'Fermeture', `Ticket fermé: ${reason}`)] });

  const messages = await message.channel.messages.fetch({ limit: 100 });
  const transcript = generateTranscript(messages, message.channel.name, message.guild.name);
  db.prepare('UPDATE tickets SET status = ? WHERE guild_id = ? AND ticket_channel_id = ?').run('closed', message.guild.id, message.channel.id);

  await triggerStatsRefresh(message.guild.id).catch(() => {});

  const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(message.guild.id);
  if (config?.log_channel_id) {
    const logChannel = message.guild.channels.cache.get(config.log_channel_id);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🎫 Ticket Fermé')
        .addFields(
          { name: 'Canal', value: message.channel.name, inline: true },
          { name: 'Fermé par', value: message.author.tag, inline: true },
          { name: 'Raison', value: reason, inline: false }
        )
        .setTimestamp();
      const buf = Buffer.from(transcript, 'utf-8');
      await logChannel.send({ embeds: [logEmbed], files: [{ attachment: buf, name: `transcript-${message.channel.name}.html` }] });
    }
  }
  setTimeout(() => message.channel.delete().catch(() => {}), 3000);
}

async function ticketAdd(message, args) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND ticket_channel_id = ?').get(message.guild.id, message.channel.id);
  if (!ticket) return message.reply({ embeds: [errorEmbed('Erreur', 'Ce canal n\'est pas un ticket.')] });
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const user = message.mentions.members.first();
  if (!user) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  await message.channel.permissionOverwrites.edit(user, { ViewChannel: true, SendMessages: true });
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Ticket', `${user} ajouté au ticket.`)] });
}

async function ticketRemove(message, args) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND ticket_channel_id = ?').get(message.guild.id, message.channel.id);
  if (!ticket) return message.reply({ embeds: [errorEmbed('Erreur', 'Ce canal n\'est pas un ticket.')] });
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const user = message.mentions.members.first();
  if (!user) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  await message.channel.permissionOverwrites.delete(user);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Ticket', `${user} retiré du ticket.`)] });
}

async function ticketRename(message, args) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND ticket_channel_id = ?').get(message.guild.id, message.channel.id);
  if (!ticket) return message.reply({ embeds: [errorEmbed('Erreur', 'Ce canal n\'est pas un ticket.')] });
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const newName = args.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!newName) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un nom valide.')] });
  await message.channel.setName(newName);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Ticket', `Canal renommé: \`${newName}\``)] });
}

async function ticketList(message) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const tickets = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND status = ?').all(message.guild.id, 'open');
  if (!tickets.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Tickets', 'Aucun ticket ouvert.')] });
  const items = tickets.map(t => `<#${t.ticket_channel_id}> — <@${t.user_id}> — <t:${t.created_at}:R>`);
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`🎫 Tickets ouverts (${tickets.length})`)
    .setDescription(items.join('\n'));
  await message.reply({ embeds: [embed] });
}

async function ticketClaim(message) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND ticket_channel_id = ?')
                   .get(message.guild.id, message.channel.id);

  if (!ticket) 
    return message.reply({ embeds: [errorEmbed('Erreur', 'Ce canal n\'est pas un ticket.')] });

  if (!isMod(message.member)) 
    return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });

  if (ticket.claimed_by && ticket.claimed_by !== message.author.id) {
    return message.reply({ embeds: [errorEmbed('Ticket déjà claimé', `Ce ticket est déjà pris par <@${ticket.claimed_by}>.`)] });
  }

  // Met à jour la DB pour marquer le ticket comme claimé
  db.prepare('UPDATE tickets SET claimed_by = ? WHERE guild_id = ? AND ticket_channel_id = ?')
    .run(message.author.id, message.guild.id, message.channel.id);

  // Message dans le ticket
  await message.channel.send({ embeds: [successEmbed(message.guild.id, 'Ticket Claim', `${message.author} a pris en charge ce ticket.`)] });

  // Log dans le salon de log si défini
  const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(message.guild.id);
  if (config?.log_channel_id) {
    const logChannel = message.guild.channels.cache.get(config.log_channel_id);
    if (logChannel) {
      await logChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(getDefaultColor(message.guild.id))
            .setTitle('🎫 Ticket Claim')
            .addFields(
              { name: 'Canal', value: `<#${message.channel.id}>`, inline: true },
              { name: 'Staff', value: message.author.tag, inline: true }
            )
            .setTimestamp()
        ]
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SYSTÈME D'ACCÈS
// ═══════════════════════════════════════════════════════════════════════════════

const defaultAccessData = () => ({
  channelId: null, roleId: null, type: 'give',
  label: 'Accéder', style: 'primary', emoji: null
});

async function cmdAccess(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez être administrateur.')] });
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });
  const id = args[0];

  switch (sub.toLowerCase()) {
    case 'create': {
      const channel = message.mentions.channels.first();
      if (!id || !channel) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `access create <id> <#salon>`')] });
      const existing = db.prepare('SELECT access_id FROM access WHERE guild_id = ? AND access_id = ?').get(message.guild.id, id);
      if (existing) return message.reply({ embeds: [errorEmbed('Erreur', `Accès \`${id}\` existe déjà.`)] });
      const data = defaultAccessData();
      data.channelId = channel.id;
      db.prepare('INSERT INTO access (guild_id, access_id, data) VALUES (?, ?, ?)').run(message.guild.id, id, JSON.stringify(data));
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Accès créé', `Accès \`${id}\` → ${channel}`)] });
    }
    case 'setrole': {
      const role = message.mentions.roles.first();
      if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
      const row = db.prepare('SELECT data FROM access WHERE guild_id = ? AND access_id = ?').get(message.guild.id, id);
      if (!row) return message.reply({ embeds: [errorEmbed('Erreur', `Accès \`${id}\` introuvable.`)] });
      const data = JSON.parse(row.data);
      data.roleId = role.id;
      db.prepare('UPDATE access SET data = ? WHERE guild_id = ? AND access_id = ?').run(JSON.stringify(data), message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Accès', `Rôle: ${role}`)] });
    }
    case 'settype': {
      const type = args[1]?.toLowerCase();
      if (!['give', 'toggle'].includes(type)) return message.reply({ embeds: [errorEmbed('Erreur', 'Types: `give`, `toggle`')] });
      const row = db.prepare('SELECT data FROM access WHERE guild_id = ? AND access_id = ?').get(message.guild.id, id);
      if (!row) return message.reply({ embeds: [errorEmbed('Erreur', `Accès \`${id}\` introuvable.`)] });
      const data = JSON.parse(row.data);
      data.type = type;
      db.prepare('UPDATE access SET data = ? WHERE guild_id = ? AND access_id = ?').run(JSON.stringify(data), message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Accès', `Type: \`${type}\``)] });
    }
    case 'setlabel': {
      const row = db.prepare('SELECT data FROM access WHERE guild_id = ? AND access_id = ?').get(message.guild.id, id);
      if (!row) return message.reply({ embeds: [errorEmbed('Erreur', `Accès \`${id}\` introuvable.`)] });
      const data = JSON.parse(row.data);
      data.label = args.slice(1).join(' ');
      db.prepare('UPDATE access SET data = ? WHERE guild_id = ? AND access_id = ?').run(JSON.stringify(data), message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Accès', `Label: \`${data.label}\``)] });
    }
    case 'setstyle': {
      const style = args[1]?.toLowerCase();
      if (!['primary', 'secondary', 'success', 'danger'].includes(style)) return message.reply({ embeds: [errorEmbed('Erreur', 'Styles valides.')] });
      const row = db.prepare('SELECT data FROM access WHERE guild_id = ? AND access_id = ?').get(message.guild.id, id);
      if (!row) return message.reply({ embeds: [errorEmbed('Erreur', `Accès \`${id}\` introuvable.`)] });
      const data = JSON.parse(row.data);
      data.style = style;
      db.prepare('UPDATE access SET data = ? WHERE guild_id = ? AND access_id = ?').run(JSON.stringify(data), message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Accès', `Style: \`${style}\``)] });
    }
    case 'list': {
      const rows = db.prepare('SELECT access_id, data FROM access WHERE guild_id = ?').all(message.guild.id);
      if (!rows.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Accès', 'Aucun accès configuré.')] });
      const items = rows.map(r => {
        const d = JSON.parse(r.data);
        return `\`${r.access_id}\` — Salon: <#${d.channelId || 'N/A'}> | Rôle: ${d.roleId ? `<@&${d.roleId}>` : 'Aucun'} | Type: \`${d.type}\``;
      });
      return message.reply({ embeds: [new EmbedBuilder().setColor(getDefaultColor(message.guild.id)).setTitle(`🔑 Accès (${rows.length})`).setDescription(items.join('\n'))] });
    }
    case 'delete': {
      const exists = db.prepare('SELECT access_id FROM access WHERE guild_id = ? AND access_id = ?').get(message.guild.id, id);
      if (!exists) return message.reply({ embeds: [errorEmbed('Erreur', `Accès \`${id}\` introuvable.`)] });
      db.prepare('DELETE FROM access WHERE guild_id = ? AND access_id = ?').run(message.guild.id, id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Accès supprimé', `Accès \`${id}\` supprimé.`)] });
    }
    default:
      return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`access ${sub}\` n'existe pas.`)] });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : MODÉRATION
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Warnings ────────────────────────────────────────────────────────────────

async function cmdWarn(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const target = message.mentions.members.first();
  if (!target) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  const reason = args.slice(1).join(' ') || 'Aucune raison';
  if (target.id === message.author.id) return message.reply({ embeds: [errorEmbed('Erreur', 'Vous ne pouvez pas vous avertir vous-même.')] });

  const result = db.prepare('INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?)').run(message.guild.id, target.id, message.author.id, reason);
  const warnId = result.lastInsertRowid;

  // DM user
  try {
    await target.send({ embeds: [new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle(`⚠️ Avertissement — ${message.guild.name}`)
      .addFields(
        { name: 'Raison', value: reason, inline: false },
        { name: 'Modérateur', value: message.author.tag, inline: true },
        { name: 'ID Warning', value: `#${warnId}`, inline: true }
      )
      .setTimestamp()] });
  } catch {}

  // Count warnings
  const count = db.prepare('SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND user_id = ?').get(message.guild.id, target.id).c;

  await message.reply({ embeds: [successEmbed(message.guild.id, 'Avertissement', `${target} a reçu un avertissement.\n**Raison:** ${reason}\n**Total:** ${count} warning(s) | **ID:** #${warnId}`)] });

  await sendLog(message.guild, new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('⚠️ Avertissement')
    .addFields(
      { name: 'Utilisateur', value: `${target.user.tag} (\`${target.id}\`)`, inline: true },
      { name: 'Modérateur', value: message.author.tag, inline: true },
      { name: 'Raison', value: reason, inline: false },
      { name: 'ID Warning', value: `#${warnId}`, inline: true },
      { name: 'Total warnings', value: `${count}`, inline: true }
    )
    .setTimestamp());
}

async function cmdWarnings(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const target = message.mentions.members.first() || message.member;
  const warns = db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY timestamp DESC').all(message.guild.id, target.id);
  if (!warns.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Warnings', `${target.user.tag} n'a aucun avertissement.`)] });
  const items = warns.map(w => `**#${w.id}** — ${w.reason}\n*Par <@${w.moderator_id}> le <t:${w.timestamp}:D>*`);
  const { items: page } = paginate(items, 0, 10);
  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle(`⚠️ Warnings — ${target.user.tag} (${warns.length})`)
    .setDescription(page.join('\n\n'))
    .setThumbnail(target.user.displayAvatarURL());
  await message.reply({ embeds: [embed] });
}

async function cmdClearWarns(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Admin requis.')] });
  const target = message.mentions.members.first();
  if (!target) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  const result = db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?').run(message.guild.id, target.id);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Warnings effacés', `${result.changes} avertissement(s) supprimé(s) pour ${target}.`)] });
}

async function cmdDelWarn(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const warnId = parseInt(args[0]);
  if (isNaN(warnId)) return message.reply({ embeds: [errorEmbed('Erreur', 'ID de warning invalide.')] });
  const warn = db.prepare('SELECT * FROM warnings WHERE id = ? AND guild_id = ?').get(warnId, message.guild.id);
  if (!warn) return message.reply({ embeds: [errorEmbed('Erreur', `Warning #${warnId} introuvable.`)] });
  db.prepare('DELETE FROM warnings WHERE id = ?').run(warnId);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Warning supprimé', `Warning #${warnId} supprimé.`)] });
}

// ─── Mute ────────────────────────────────────────────────────────────────────

async function cmdMute(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const target = message.mentions.members.first();
  if (!target) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });

  let durationStr = args[1];
  let duration = null;
  let reasonStart = 2;

  if (durationStr && durationStr !== 'permanent') {
    duration = parseDuration(durationStr);
    if (duration === null) { reasonStart = 1; }
  }

  const reason = args.slice(reasonStart).join(' ') || 'Aucune raison';
  const muteRoleId = getConfig(message.guild.id, 'mute_role');

  if (muteRoleId) {
    const muteRole = message.guild.roles.cache.get(muteRoleId);
    if (muteRole) await target.roles.add(muteRole);
  } else {
    // Use Discord timeout
    try {
      const timeoutDuration = duration || 28 * 24 * 60 * 60 * 1000; // Max 28 days
      await target.timeout(Math.min(timeoutDuration, 2419200000), reason);
    } catch (err) {
      return message.reply({ embeds: [errorEmbed('Erreur', `Impossible de muter: ${err.message}`)] });
    }
  }

  const expiresAt = duration ? Math.floor((Date.now() + duration) / 1000) : null;
  db.prepare('INSERT OR REPLACE INTO mutes (guild_id, user_id, expires_at, reason) VALUES (?, ?, ?, ?)').run(message.guild.id, target.id, expiresAt, reason);

  const durationText = duration ? formatDuration(duration) : 'Permanent';
  try {
    await target.send({ embeds: [new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle(`🔇 Vous avez été muté — ${message.guild.name}`)
      .addFields(
        { name: 'Raison', value: reason, inline: false },
        { name: 'Durée', value: durationText, inline: true },
        { name: 'Modérateur', value: message.author.tag, inline: true }
      )
      .setTimestamp()] });
  } catch {}

  await message.reply({ embeds: [successEmbed(message.guild.id, 'Mute', `${target} a été muté.\n**Durée:** ${durationText}\n**Raison:** ${reason}`)] });
  await sendLog(message.guild, new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('🔇 Mute')
    .addFields(
      { name: 'Utilisateur', value: `${target.user.tag} (\`${target.id}\`)`, inline: true },
      { name: 'Modérateur', value: message.author.tag, inline: true },
      { name: 'Durée', value: durationText, inline: true },
      { name: 'Raison', value: reason, inline: false }
    )
    .setTimestamp());
}

async function cmdUnmute(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const target = message.mentions.members.first();
  if (!target) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  const muteRoleId = getConfig(message.guild.id, 'mute_role');
  if (muteRoleId) {
    const muteRole = message.guild.roles.cache.get(muteRoleId);
    if (muteRole) await target.roles.remove(muteRole);
  } else {
    await target.timeout(null).catch(() => {});
  }
  db.prepare('DELETE FROM mutes WHERE guild_id = ? AND user_id = ?').run(message.guild.id, target.id);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Unmute', `${target} a été démuté.`)] });
  await sendLog(message.guild, new EmbedBuilder()
    .setColor('#57F287')
    .setTitle('🔊 Unmute')
    .addFields(
      { name: 'Utilisateur', value: `${target.user.tag} (\`${target.id}\`)`, inline: true },
      { name: 'Modérateur', value: message.author.tag, inline: true }
    )
    .setTimestamp());
}

/**
 * Auto-unmute check (runs every 30 seconds)
 */
function startAutoUnmute() {
  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = db.prepare('SELECT * FROM mutes WHERE expires_at IS NOT NULL AND expires_at <= ?').all(now);
    for (const mute of expired) {
      try {
        const guild = client.guilds.cache.get(mute.guild_id);
        if (!guild) continue;
        const member = await guild.members.fetch(mute.user_id).catch(() => null);
        if (!member) continue;
        const muteRoleId = getConfig(guild.id, 'mute_role');
        if (muteRoleId) {
          const muteRole = guild.roles.cache.get(muteRoleId);
          if (muteRole && member.roles.cache.has(muteRoleId)) await member.roles.remove(muteRole);
        } else {
          await member.timeout(null).catch(() => {});
        }
        db.prepare('DELETE FROM mutes WHERE guild_id = ? AND user_id = ?').run(guild.id, mute.user_id);
        await sendLog(guild, new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('🔊 Unmute automatique')
          .addFields({ name: 'Utilisateur', value: `<@${mute.user_id}>`, inline: true })
          .setTimestamp());
      } catch (err) {
        console.error('Auto-unmute error:', err);
      }
    }
  }, 30000);
}

// ─── Kick / Ban ───────────────────────────────────────────────────────────────

async function cmdKick(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  if (!message.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply({ embeds: [errorEmbed('Erreur', 'Le bot n\'a pas la permission d\'expulser.')] });
  const target = message.mentions.members.first();
  if (!target) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  if (!target.kickable) return message.reply({ embeds: [errorEmbed('Erreur', 'Je ne peux pas expulser cet utilisateur.')] });
  const reason = args.slice(1).join(' ') || 'Aucune raison';
  try {
    await target.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle(`👢 Expulsé — ${message.guild.name}`).addFields({ name: 'Raison', value: reason }, { name: 'Modérateur', value: message.author.tag }).setTimestamp()] });
  } catch {}
  await target.kick(reason);
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Kick', `${target.user.tag} a été expulsé.\n**Raison:** ${reason}`)] });
  await sendLog(message.guild, new EmbedBuilder().setColor('#ED4245').setTitle('👢 Expulsion').addFields({ name: 'Utilisateur', value: `${target.user.tag} (\`${target.id}\`)`, inline: true }, { name: 'Modérateur', value: message.author.tag, inline: true }, { name: 'Raison', value: reason }).setTimestamp());
}

async function cmdBan(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  if (!message.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply({ embeds: [errorEmbed('Erreur', 'Le bot n\'a pas la permission de bannir.')] });
  const target = message.mentions.members.first();
  if (!target) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  if (!target.bannable) return message.reply({ embeds: [errorEmbed('Erreur', 'Je ne peux pas bannir cet utilisateur.')] });
  const reason = args.slice(1).join(' ') || 'Aucune raison';
  try {
    await target.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle(`🔨 Banni — ${message.guild.name}`).addFields({ name: 'Raison', value: reason }, { name: 'Modérateur', value: message.author.tag }).setTimestamp()] });
  } catch {}
  await target.ban({ reason, deleteMessageSeconds: 604800 });
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Ban', `${target.user.tag} a été banni.\n**Raison:** ${reason}`)] });
  await sendLog(message.guild, new EmbedBuilder().setColor('#ED4245').setTitle('🔨 Ban').addFields({ name: 'Utilisateur', value: `${target.user.tag} (\`${target.id}\`)`, inline: true }, { name: 'Modérateur', value: message.author.tag, inline: true }, { name: 'Raison', value: reason }).setTimestamp());
}

async function cmdUnban(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const userId = args[0];
  if (!userId) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un ID utilisateur.')] });
  try {
    const ban = await message.guild.bans.fetch(userId);
    await message.guild.members.unban(userId);
    await message.reply({ embeds: [successEmbed(message.guild.id, 'Unban', `${ban.user.tag} a été débanni.`)] });
    await sendLog(message.guild, new EmbedBuilder().setColor('#57F287').setTitle('🔓 Unban').addFields({ name: 'Utilisateur', value: `${ban.user.tag} (\`${userId}\`)`, inline: true }, { name: 'Modérateur', value: message.author.tag, inline: true }).setTimestamp());
  } catch {
    await message.reply({ embeds: [errorEmbed('Erreur', 'Utilisateur introuvable dans les bans.')] });
  }
}

async function cmdSoftBan(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const target = message.mentions.members.first();
  if (!target) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur.')] });
  if (!target.bannable) return message.reply({ embeds: [errorEmbed('Erreur', 'Je ne peux pas bannir cet utilisateur.')] });
  const reason = args.slice(1).join(' ') || 'Softban';
  try {
    await target.send({ embeds: [new EmbedBuilder().setColor('#FFA500').setTitle(`🔨 Softban — ${message.guild.name}`).addFields({ name: 'Raison', value: reason }).setTimestamp()] });
  } catch {}
  await target.ban({ reason, deleteMessageSeconds: 604800 });
  await message.guild.members.unban(target.id, 'Softban — débannissement automatique');
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Softban', `${target.user.tag} a été softban (messages supprimés, maintenant débanni).`)] });
  await sendLog(message.guild, new EmbedBuilder().setColor('#FFA500').setTitle('🔨 Softban').addFields({ name: 'Utilisateur', value: `${target.user.tag} (\`${target.id}\`)`, inline: true }, { name: 'Modérateur', value: message.author.tag, inline: true }, { name: 'Raison', value: reason }).setTimestamp());
}

async function cmdBanList(message) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const bans = await message.guild.bans.fetch();
  if (!bans.size) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Banlist', 'Aucun utilisateur banni.')] });
  const items = bans.map(b => `• ${b.user.tag} (\`${b.user.id}\`) — ${b.reason || 'Aucune raison'}`);
  const { items: page } = paginate(items, 0, 20);
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`🔨 Banlist (${bans.size})`)
    .setDescription(page.join('\n'));
  await message.reply({ embeds: [embed] });
}

// ─── Channel Moderation ───────────────────────────────────────────────────────

async function cmdPurge(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const amount = parseInt(args[0]);
  if (isNaN(amount) || amount < 1 || amount > 100) return message.reply({ embeds: [errorEmbed('Erreur', 'Nombre entre 1 et 100.')] });
  try {
    const msgs = await message.channel.messages.fetch({ limit: amount + 1 });
    // Filter out messages older than 14 days
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const deletable = msgs.filter(m => m.createdTimestamp > twoWeeksAgo && m.id !== message.id);
    const deleted = await message.channel.bulkDelete(deletable, true);
    const confirmMsg = await message.channel.send({ embeds: [successEmbed(message.guild.id, 'Purge', `${deleted.size} message(s) supprimé(s).`)] });
    setTimeout(() => confirmMsg.delete().catch(() => {}), 3000);
    await message.delete().catch(() => {});
    await sendLog(message.guild, new EmbedBuilder().setColor('#ED4245').setTitle('🗑️ Purge').addFields({ name: 'Canal', value: `<#${message.channel.id}>`, inline: true }, { name: 'Messages supprimés', value: `${deleted.size}`, inline: true }, { name: 'Modérateur', value: message.author.tag, inline: true }).setTimestamp());
  } catch (err) {
    await message.reply({ embeds: [errorEmbed('Erreur', `Impossible de supprimer: ${err.message}`)] });
  }
}

async function cmdSlowmode(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const seconds = parseInt(args[0]);
  if (isNaN(seconds) || seconds < 0 || seconds > 21600) return message.reply({ embeds: [errorEmbed('Erreur', 'Valeur entre 0 et 21600 secondes.')] });
  await message.channel.setRateLimitPerUser(seconds);
  const text = seconds === 0 ? 'Slowmode désactivé.' : `Slowmode: \`${seconds}s\``;
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Slowmode', text)] });
}

async function cmdLock(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const channel = message.mentions.channels.first() || message.channel;
  await channel.permissionOverwrites.edit(message.guild.id, { SendMessages: false });
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Lock', `${channel} est maintenant verrouillé.`)] });
  await sendLog(message.guild, new EmbedBuilder().setColor('#ED4245').setTitle('🔒 Lock').addFields({ name: 'Canal', value: `${channel}`, inline: true }, { name: 'Modérateur', value: message.author.tag, inline: true }).setTimestamp());
}

async function cmdUnlock(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const channel = message.mentions.channels.first() || message.channel;
  await channel.permissionOverwrites.edit(message.guild.id, { SendMessages: null });
  await message.reply({ embeds: [successEmbed(message.guild.id, 'Unlock', `${channel} est maintenant déverrouillé.`)] });
  await sendLog(message.guild, new EmbedBuilder().setColor('#57F287').setTitle('🔓 Unlock').addFields({ name: 'Canal', value: `${channel}`, inline: true }, { name: 'Modérateur', value: message.author.tag, inline: true }).setTimestamp());
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : GESTION DES RÔLES
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdRole(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Admin requis.')] });
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });

  switch (sub.toLowerCase()) {
    case 'add': {
      const member = message.mentions.members.first();
      const role = message.mentions.roles.first();
      if (!member || !role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur et un rôle.')] });
      await member.roles.add(role);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle', `${role} donné à ${member}.`)] });
    }
    case 'remove': {
      const member = message.mentions.members.first();
      const role = message.mentions.roles.first();
      if (!member || !role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un utilisateur et un rôle.')] });
      await member.roles.remove(role);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle', `${role} retiré de ${member}.`)] });
    }
    case 'create': {
      const name = args[0];
      const color = args[1];
      if (!name) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un nom.')] });
      const roleData = { name };
      if (color && isValidHex(color)) roleData.color = color;
      const newRole = await message.guild.roles.create(roleData);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle créé', `${newRole} créé.`)] });
    }
    case 'delete': {
      const role = message.mentions.roles.first();
      if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
      await role.delete();
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle supprimé', `Rôle **${role.name}** supprimé.`)] });
    }
    case 'color': {
      const role = message.mentions.roles.first();
      const color = args.find(a => isValidHex(a));
      if (!role || !color) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle et spécifiez une couleur HEX.')] });
      await role.setColor(color);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle', `Couleur de ${role}: \`${color}\``)] });
    }
    case 'info': {
      const role = message.mentions.roles.first();
      if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
      const perms = role.permissions.toArray().slice(0, 10).join(', ') || 'Aucune';
      const embed = new EmbedBuilder()
        .setColor(role.hexColor || getDefaultColor(message.guild.id))
        .setTitle(`🎭 Rôle — ${role.name}`)
        .addFields(
          { name: 'ID', value: `\`${role.id}\``, inline: true },
          { name: 'Couleur', value: `\`${role.hexColor}\``, inline: true },
          { name: 'Membres', value: `\`${role.members.size}\``, inline: true },
          { name: 'Mentionnable', value: role.mentionable ? '✅' : '❌', inline: true },
          { name: 'Séparé', value: role.hoist ? '✅' : '❌', inline: true },
          { name: 'Géré', value: role.managed ? '✅' : '❌', inline: true },
          { name: 'Créé le', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:F>`, inline: false },
          { name: 'Permissions', value: perms, inline: false }
        );
      return message.reply({ embeds: [embed] });
    }
    case 'members': {
      const role = message.mentions.roles.first();
      if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
      await message.guild.members.fetch();
      const members = role.members;
      if (!members.size) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Membres', `Aucun membre avec ${role}.`)] });
      const { items } = paginate([...members.values()].map(m => `• ${m.user.tag}`), 0, 20);
      const embed = new EmbedBuilder()
        .setColor(role.hexColor || getDefaultColor(message.guild.id))
        .setTitle(`🎭 Membres — ${role.name} (${members.size})`)
        .setDescription(items.join('\n'));
      return message.reply({ embeds: [embed] });
    }
    case 'hoist': {
      const role = message.mentions.roles.first();
      if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
      await role.setHoist(!role.hoist);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle', `Affichage séparé: \`${!role.hoist ? 'activé' : 'désactivé'}\``)] });
    }
    case 'mentionable': {
      const role = message.mentions.roles.first();
      if (!role) return message.reply({ embeds: [errorEmbed('Erreur', 'Mentionnez un rôle.')] });
      await role.setMentionable(!role.mentionable);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Rôle', `Mentionnable: \`${!role.mentionable ? 'activé' : 'désactivé'}\``)] });
    }
    default:
      return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`role ${sub}\` n'existe pas.`)] });
  }
}

// ─── Reaction Roles ───────────────────────────────────────────────────────────

async function cmdReactionRole(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Admin requis.')] });
  const sub = args.shift();

  switch (sub?.toLowerCase()) {
    case 'set': {
      const msgId = args[0];
      const emoji = args[1];
      const role = message.mentions.roles.first();
      if (!msgId || !emoji || !role) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `reactionrole set <msg_id> <emoji> <@role>`')] });
      // Verify message exists
      try {
        const targetMsg = await message.channel.messages.fetch(msgId);
        await targetMsg.react(emoji);
      } catch {
        return message.reply({ embeds: [errorEmbed('Erreur', 'Message ou emoji invalide.')] });
      }
      db.prepare('INSERT OR REPLACE INTO reaction_roles (guild_id, message_id, emoji, role_id) VALUES (?, ?, ?, ?)').run(message.guild.id, msgId, emoji, role.id);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Reaction Role', `${emoji} → ${role} sur le message \`${msgId}\``)] });
    }
    case 'remove': {
      const msgId = args[0];
      const emoji = args[1];
      if (!msgId || !emoji) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `reactionrole remove <msg_id> <emoji>`')] });
      db.prepare('DELETE FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?').run(message.guild.id, msgId, emoji);
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Reaction Role', `Association supprimée.`)] });
    }
    case 'list': {
      const rrs = db.prepare('SELECT * FROM reaction_roles WHERE guild_id = ?').all(message.guild.id);
      if (!rrs.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Reaction Roles', 'Aucune association.')] });
      const items = rrs.map(r => `Message \`${r.message_id}\` | ${r.emoji} → <@&${r.role_id}>`);
      return message.reply({ embeds: [new EmbedBuilder().setColor(getDefaultColor(message.guild.id)).setTitle(`🎭 Reaction Roles (${rrs.length})`).setDescription(items.join('\n'))] });
    }
    default:
      return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', 'Sous-commandes: `set`, `remove`, `list`')] });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : COMMANDES PERSONNALISÉES
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdCC(message, args) {
  if (!isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Admin requis.')] });
  const sub = args.shift();
  if (!sub) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une sous-commande.')] });

  switch (sub.toLowerCase()) {
    case 'create': {
      const name = args.shift();
      const response = args.join(' ');
      if (!name) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un nom.')] });
      const exists = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(message.guild.id, name);
      if (exists) return message.reply({ embeds: [errorEmbed('Erreur', `La commande \`${name}\` existe déjà.`)] });
      db.prepare('INSERT INTO custom_commands (guild_id, name, response) VALUES (?, ?, ?)').run(message.guild.id, name, response || '');
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Commande créée', `Commande \`${name}\` créée.`)] });
    }
    case 'edit': {
      const name = args.shift();
      const response = args.join(' ');
      if (!name || !response) return message.reply({ embeds: [errorEmbed('Erreur', 'Usage: `cc edit <nom> <réponse>`')] });
      const result = db.prepare('UPDATE custom_commands SET response = ? WHERE guild_id = ? AND name = ?').run(response, message.guild.id, name);
      if (!result.changes) return message.reply({ embeds: [errorEmbed('Erreur', `Commande \`${name}\` introuvable.`)] });
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Commande modifiée', `\`${name}\` mis à jour.`)] });
    }
    case 'delete': {
      const name = args[0];
      if (!name) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un nom.')] });
      const result = db.prepare('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?').run(message.guild.id, name);
      if (!result.changes) return message.reply({ embeds: [errorEmbed('Erreur', `Commande \`${name}\` introuvable.`)] });
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Commande supprimée', `\`${name}\` supprimée.`)] });
    }
    case 'list': {
      const cmds = db.prepare('SELECT name, response, embed_id FROM custom_commands WHERE guild_id = ?').all(message.guild.id);
      if (!cmds.length) return message.reply({ embeds: [infoEmbed(message.guild.id, 'Commandes perso', 'Aucune commande.')] });
      const items = cmds.map(c => `\`${c.name}\` — ${c.embed_id ? `[Embed: ${c.embed_id}]` : (c.response?.substring(0, 40) || '*(vide)*')}`);
      return message.reply({ embeds: [new EmbedBuilder().setColor(getDefaultColor(message.guild.id)).setTitle(`⚡ Commandes personnalisées (${cmds.length})`).setDescription(items.join('\n'))] });
    }
    case 'info': {
      const name = args[0];
      const cmd = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?').get(message.guild.id, name);
      if (!cmd) return message.reply({ embeds: [errorEmbed('Erreur', `Commande \`${name}\` introuvable.`)] });
      const embed = new EmbedBuilder()
        .setColor(getDefaultColor(message.guild.id))
        .setTitle(`⚡ Info — \`${name}\``)
        .addFields(
          { name: 'Réponse', value: cmd.response || '*(vide)*', inline: false },
          { name: 'Embed', value: cmd.embed_id || 'Aucun', inline: true },
          { name: 'Créé le', value: `<t:${cmd.created_at}:F>`, inline: false }
        );
      return message.reply({ embeds: [embed] });
    }
    case 'setembed': {
      const name = args[0];
      const embedId = args[1];
      if (!name) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez un nom.')] });
      const result = db.prepare('UPDATE custom_commands SET embed_id = ? WHERE guild_id = ? AND name = ?').run(embedId || null, message.guild.id, name);
      if (!result.changes) return message.reply({ embeds: [errorEmbed('Erreur', `Commande \`${name}\` introuvable.`)] });
      return message.reply({ embeds: [successEmbed(message.guild.id, 'Commande', `Embed associé: \`${embedId || 'aucun'}\``)] });
    }
    default:
      return message.reply({ embeds: [errorEmbed('Sous-commande inconnue', `\`cc ${sub}\` n'existe pas.`)] });
  }
}

/**
 * Handle custom command execution
 */
async function handleCustomCommand(message, prefix) {
  const firstWord = message.content.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord || message.content.startsWith(prefix)) return;

  // Strip prefix if message starts with it (shouldn't happen here but safety check)
  const commandName = firstWord.replace(/^[^a-z0-9]*/i, '');
  const cmd = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?').get(message.guild.id, commandName);
  if (!cmd) return;

  // Replace variables
  const response = replaceVariables(cmd.response || '', message.member);

  if (cmd.embed_id) {
    const embedData = getEmbed(message.guild.id, cmd.embed_id);
    if (embedData) {
      await message.channel.send({ embeds: [buildEmbed(embedData, message.guild.id)] });
      return;
    }
  }

  if (response) {
    await message.channel.send(response);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : SONDAGES
// ═══════════════════════════════════════════════════════════════════════════════

const pollEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

async function cmdPoll(message, args) {
  if (!isMod(message.member)) return message.reply({ embeds: [errorEmbed('Permission refusée', 'Modérateur requis.')] });
  const sub = args.shift();

  if (sub === 'create') {
    const question = args.join(' ');
    if (!question) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez une question.')] });
    return createYesNoPoll(message, question);
  }

  if (sub === 'multichoice') {
    const parts = args.join(' ').split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) return message.reply({ embeds: [errorEmbed('Erreur', 'Format: `poll multichoice <question> | <opt1> | <opt2> | ...`')] });
    const question = parts[0];
    const options = parts.slice(1, 11); // Max 10 options
    return createMultiChoicePoll(message, question, options);
  }

  if (sub === 'end') {
    const msgId = args[0];
    if (!msgId) return message.reply({ embeds: [errorEmbed('Erreur', 'Spécifiez l\'ID du message.')] });
    return endPoll(message, msgId);
  }

  await message.reply({ embeds: [errorEmbed('Sous-commande inconnue', 'Sous-commandes: `create`, `multichoice`, `end`')] });
}

async function createYesNoPoll(message, question) {
  const options = ['✅ Oui', '❌ Non'];
  const optionsJson = JSON.stringify(options);

  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`📊 ${question}`)
    .setDescription(`✅ **Oui:** 0 vote (0%)\n❌ **Non:** 0 vote (0%)`)
    .setFooter({ text: 'Cliquez sur un bouton pour voter' })
    .setTimestamp();

  const yesBtn = new ButtonBuilder().setCustomId(`poll_yes`).setLabel('✅ Oui').setStyle(ButtonStyle.Success);
  const noBtn = new ButtonBuilder().setCustomId(`poll_no`).setLabel('❌ Non').setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder().addComponents(yesBtn, noBtn);

  const pollMsg = await message.channel.send({ embeds: [embed], components: [row] });
  await message.delete().catch(() => {});

  db.prepare('INSERT INTO polls (guild_id, message_id, question, options, type, channel_id) VALUES (?, ?, ?, ?, ?, ?)').run(message.guild.id, pollMsg.id, question, optionsJson, 'yesno', message.channel.id);
  pollVotes.set(pollMsg.id, {});
}

async function createMultiChoicePoll(message, question, options) {
  const optionsJson = JSON.stringify(options);

  let description = options.map((opt, i) => `${pollEmojis[i]} **${opt}:** 0 vote (0%)`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`📊 ${question}`)
    .setDescription(description)
    .setFooter({ text: 'Cliquez sur un bouton pour voter' })
    .setTimestamp();

  const rows = [];
  let currentRow = new ActionRowBuilder();
  options.forEach((opt, i) => {
    if (i > 0 && i % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    const btn = new ButtonBuilder()
      .setCustomId(`poll_opt_${i}`)
      .setLabel(`${pollEmojis[i]} ${opt.substring(0, 20)}`)
      .setStyle(ButtonStyle.Primary);
    currentRow.addComponents(btn);
  });
  rows.push(currentRow);

  const pollMsg = await message.channel.send({ embeds: [embed], components: rows });
  await message.delete().catch(() => {});

  db.prepare('INSERT INTO polls (guild_id, message_id, question, options, type, channel_id) VALUES (?, ?, ?, ?, ?, ?)').run(message.guild.id, pollMsg.id, question, optionsJson, 'multichoice', message.channel.id);
  pollVotes.set(pollMsg.id, {});
}

async function handlePollVote(interaction) {
  try {
    const customId = interaction.customId;
    const msgId = interaction.message.id;
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const pollRow = db.prepare('SELECT * FROM polls WHERE guild_id = ? AND message_id = ?').get(guildId, msgId);
    if (!pollRow) return interaction.reply({ content: '❌ Sondage introuvable.', ephemeral: true });
    if (pollRow.ended) return interaction.reply({ content: '❌ Ce sondage est terminé.', ephemeral: true });

    const options = JSON.parse(pollRow.options);
    let optionIndex;

    if (pollRow.type === 'yesno') {
      optionIndex = customId === 'poll_yes' ? 0 : 1;
    } else {
      optionIndex = parseInt(customId.replace('poll_opt_', ''));
    }

    if (isNaN(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      return interaction.reply({ content: '❌ Option invalide.', ephemeral: true });
    }

    // Check existing vote
    const existing = db.prepare('SELECT option_index FROM poll_votes WHERE guild_id = ? AND message_id = ? AND user_id = ?').get(guildId, msgId, userId);

    let changed = false;
    if (existing) {
      if (existing.option_index === optionIndex) {
        // Remove vote (toggle)
        db.prepare('DELETE FROM poll_votes WHERE guild_id = ? AND message_id = ? AND user_id = ?').run(guildId, msgId, userId);
        changed = true;
      } else {
        // Change vote
        db.prepare('UPDATE poll_votes SET option_index = ? WHERE guild_id = ? AND message_id = ? AND user_id = ?').run(optionIndex, guildId, msgId, userId);
        changed = true;
      }
    } else {
      db.prepare('INSERT INTO poll_votes (guild_id, message_id, user_id, option_index) VALUES (?, ?, ?, ?)').run(guildId, msgId, userId, optionIndex);
      changed = true;
    }

    if (changed) {
      // Update the poll message
      await updatePollMessage(interaction.message, pollRow, guildId);
    }

    const action = existing && existing.option_index === optionIndex ? 'retiré' : 'enregistré';
    await interaction.reply({ content: `✅ Vote ${action}!`, ephemeral: true });
  } catch (err) {
    console.error('Poll vote error:', err);
    if (!interaction.replied) await interaction.reply({ content: '❌ Erreur lors du vote.', ephemeral: true });
  }
}

async function updatePollMessage(pollMessage, pollRow, guildId) {
  try {
    const options = JSON.parse(pollRow.options);
    const votes = db.prepare('SELECT option_index, COUNT(*) as count FROM poll_votes WHERE guild_id = ? AND message_id = ? GROUP BY option_index').all(guildId, pollRow.message_id);
    const totalVotes = votes.reduce((sum, v) => sum + v.count, 0);
    const voteCounts = Array(options.length).fill(0);
    votes.forEach(v => { voteCounts[v.option_index] = v.count; });

    let description;
    if (pollRow.type === 'yesno') {
      description = [
        `✅ **Oui:** ${voteCounts[0]} vote${voteCounts[0] !== 1 ? 's' : ''} (${totalVotes ? Math.round(voteCounts[0] / totalVotes * 100) : 0}%)`,
        `❌ **Non:** ${voteCounts[1]} vote${voteCounts[1] !== 1 ? 's' : ''} (${totalVotes ? Math.round(voteCounts[1] / totalVotes * 100) : 0}%)`
      ].join('\n');
    } else {
      description = options.map((opt, i) => {
        const count = voteCounts[i];
        const pct = totalVotes ? Math.round(count / totalVotes * 100) : 0;
        const bar = '▓'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        return `${pollEmojis[i]} **${opt}**\n${bar} ${count} vote${count !== 1 ? 's' : ''} (${pct}%)`;
      }).join('\n\n');
    }

    const newEmbed = EmbedBuilder.from(pollMessage.embeds[0])
      .setDescription(description)
      .setFooter({ text: `${totalVotes} vote${totalVotes !== 1 ? 's' : ''} au total` });

    await pollMessage.edit({ embeds: [newEmbed] });
  } catch (err) {
    console.error('Update poll error:', err);
  }
}

async function endPoll(message, msgId) {
  const pollRow = db.prepare('SELECT * FROM polls WHERE guild_id = ? AND message_id = ?').get(message.guild.id, msgId);
  if (!pollRow) return message.reply({ embeds: [errorEmbed('Erreur', 'Sondage introuvable.')] });
  if (pollRow.ended) return message.reply({ embeds: [errorEmbed('Erreur', 'Ce sondage est déjà terminé.')] });

  db.prepare('UPDATE polls SET ended = 1 WHERE guild_id = ? AND message_id = ?').run(message.guild.id, msgId);

  try {
    const channel = message.guild.channels.cache.get(pollRow.channel_id || message.channel.id);
    if (channel) {
      const pollMsg = await channel.messages.fetch(msgId);
      const options = JSON.parse(pollRow.options);
      const votes = db.prepare('SELECT option_index, COUNT(*) as count FROM poll_votes WHERE guild_id = ? AND message_id = ? GROUP BY option_index').all(message.guild.id, msgId);
      const totalVotes = votes.reduce((sum, v) => sum + v.count, 0);
      const voteCounts = Array(options.length).fill(0);
      votes.forEach(v => { voteCounts[v.option_index] = v.count; });

      const winnerIndex = voteCounts.indexOf(Math.max(...voteCounts));
      const winner = options[winnerIndex];

      let description;
      if (pollRow.type === 'yesno') {
        description = [
          `✅ **Oui:** ${voteCounts[0]} vote(s) (${totalVotes ? Math.round(voteCounts[0] / totalVotes * 100) : 0}%)`,
          `❌ **Non:** ${voteCounts[1]} vote(s) (${totalVotes ? Math.round(voteCounts[1] / totalVotes * 100) : 0}%)`,
          `\n🏆 **Résultat:** ${winner}`
        ].join('\n');
      } else {
        description = options.map((opt, i) => {
          const count = voteCounts[i];
          const pct = totalVotes ? Math.round(count / totalVotes * 100) : 0;
          return `${pollEmojis[i]} **${opt}:** ${count} vote(s) (${pct}%)`;
        }).join('\n') + `\n\n🏆 **Gagnant:** ${winner}`;
      }

      const finalEmbed = EmbedBuilder.from(pollMsg.embeds[0])
        .setTitle(`📊 [TERMINÉ] ${pollRow.question}`)
        .setDescription(description)
        .setFooter({ text: `${totalVotes} vote(s) au total | Sondage terminé` })
        .setColor('#57F287');

      // Disable all buttons
      const disabledRows = pollMsg.components.map(row => {
        const newRow = new ActionRowBuilder();
        row.components.forEach(btn => {
          newRow.addComponents(ButtonBuilder.from(btn).setDisabled(true));
        });
        return newRow;
      });

      await pollMsg.edit({ embeds: [finalEmbed], components: disabledRows });
    }
  } catch (err) {
    console.error('End poll error:', err);
  }

  await message.reply({ embeds: [successEmbed(message.guild.id, 'Sondage terminé', `Le sondage \`${msgId}\` est maintenant terminé.`)] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : AIDE
// ═══════════════════════════════════════════════════════════════════════════════

const helpCategories = {
  utilitaires: {
    emoji: '🔧',
    description: 'Commandes utilitaires générales',
    commands: [
      { name: 'ping', desc: 'Latence API + WebSocket' },
      { name: 'uptime', desc: 'Durée en ligne du bot' },
      { name: 'botinfo', desc: 'Informations sur le bot' },
      { name: 'serverinfo', desc: 'Informations sur le serveur' },
      { name: 'userinfo [@user]', desc: 'Informations sur un utilisateur' },
      { name: 'avatar [@user]', desc: 'Avatar en grande taille' },
    ]
  },
  config: {
    emoji: '⚙️',
    description: 'Configuration du serveur',
    commands: [
      { name: 'setprefix <prefix>', desc: 'Change le préfixe' },
      { name: 'setlogchannel <#salon>', desc: 'Salon de logs global' },
      { name: 'setadminrole <@role>', desc: 'Ajoute un rôle admin' },
      { name: 'setmodrole <@role>', desc: 'Ajoute un rôle modérateur' },
      { name: 'setmuterole <@role>', desc: 'Définit le rôle Muted' },
      { name: 'autorole <@role|disable>', desc: 'Rôle auto à l\'arrivée' },
      { name: 'setwelcome', desc: 'Configure le welcome' },
      { name: 'welcometest', desc: 'Teste le message de bienvenue' },
      { name: 'setcolor <#HEX>', desc: 'Couleur par défaut des embeds' },
    ]
  },
  embeds: {
    emoji: '📝',
    description: 'Création et gestion des embeds',
    commands: [
      { name: 'embed create <id>', desc: 'Crée un embed vide' },
      { name: 'embed title <id> <titre>', desc: 'Définit le titre' },
      { name: 'embed description <id> <texte>', desc: 'Définit la description' },
      { name: 'embed color <id> <#HEX>', desc: 'Définit la couleur' },
      { name: 'embed image <id> <url>', desc: 'Image principale' },
      { name: 'embed thumbnail <id> <url>', desc: 'Miniature' },
      { name: 'embed footer <id> <texte>', desc: 'Texte du footer' },
      { name: 'embed author <id> <nom>', desc: 'Nom de l\'auteur' },
      { name: 'embed addfield <id> <nom> | <valeur>', desc: 'Ajoute un champ' },
      { name: 'embed addinlinefield <id> <nom> | <valeur>', desc: 'Champ inline' },
      { name: 'embed preview <id>', desc: 'Prévisualise dans le canal' },
      { name: 'embed send <id> [#salon]', desc: 'Envoie l\'embed' },
      { name: 'embed edit <id> <msg_id> [#salon]', desc: 'Édite un message existant' },
      { name: 'embed list', desc: 'Liste tous les embeds' },
      { name: 'embed delete <id>', desc: 'Supprime un embed' },
      { name: 'embed clone <id> <nouvel_id>', desc: 'Clone un embed' },
      { name: 'embed info <id>', desc: 'Informations sur un embed' },
    ]
  },
  annonces: {
    emoji: '📢',
    description: 'Création et envoi d\'annonces',
    commands: [
      { name: 'announce create <id>', desc: 'Crée une annonce' },
      { name: 'announce title <id> <titre>', desc: 'Définit le titre' },
      { name: 'announce description <id> <texte>', desc: 'Définit la description' },
      { name: 'announce addbutton <id> <btn_id>', desc: 'Attache un bouton' },
      { name: 'announce content <id> <texte>', desc: 'Texte brut avant l\'embed' },
      { name: 'announce send <id> [#salon]', desc: 'Envoie l\'annonce' },
      { name: 'announce edit <id> <msg_id> [#salon]', desc: 'Édite une annonce' },
      { name: 'announce list', desc: 'Liste des annonces' },
      { name: 'announce delete <id>', desc: 'Supprime une annonce' },
    ]
  },
  boutons: {
    emoji: '🔘',
    description: 'Création et gestion des boutons',
    commands: [
      { name: 'button create <id> <label>', desc: 'Crée un bouton' },
      { name: 'button label <id> <texte>', desc: 'Modifie le label' },
      { name: 'button style <id> <style>', desc: 'Définit le style' },
      { name: 'button emoji <id> <emoji>', desc: 'Définit l\'emoji' },
      { name: 'button action <id> <type>', desc: 'Définit l\'action' },
      { name: 'button settarget <id> <valeur>', desc: 'Définit la cible' },
      { name: 'button setmessage <id> <texte>', desc: 'Message de réponse' },
      { name: 'button setembed <id> <embed_id>', desc: 'Embed de réponse' },
      { name: 'button ephemeral <id> <true|false>', desc: 'Réponse éphémère' },
      { name: 'button list', desc: 'Liste des boutons' },
      { name: 'button info <id>', desc: 'Informations sur un bouton' },
    ]
  },
  auth: {
    emoji: '🔐',
    description: 'Boutons d\'authentification OAuth2',
    commands: [
      { name: 'auth create <id> <label>', desc: 'Crée un bouton auth' },
      { name: 'auth setguild <id> <guild_id>', desc: 'Serveur cible' },
      { name: 'auth setsuccess <id> <texte>', desc: 'Message de succès' },
      { name: 'auth setdm <id> <true|false>', desc: 'DM en cas de succès' },
      { name: 'auth setlog <id> <#salon>', desc: 'Salon de log' },
      { name: 'auth setrequirerole <id> <@role>', desc: 'Rôle requis' },
      { name: 'auth list', desc: 'Liste des boutons auth' },
      { name: 'auth info <id>', desc: 'Informations' },
      { name: 'auth preview <id>', desc: 'Prévisualisation' },
    ]
  },
  tickets: {
    emoji: '🎫',
    description: 'Système de tickets',
    commands: [
      { name: 'ticket setup', desc: 'Assistant de configuration' },
      { name: 'ticket setcategory <#catégorie>', desc: 'Catégorie des tickets' },
      { name: 'ticket setlog <#salon>', desc: 'Salon de logs' },
      { name: 'ticket setsupport <@role>', desc: 'Rôle de support' },
      { name: 'ticket panel [#salon]', desc: 'Crée le panel' },
      { name: 'ticket close [raison]', desc: 'Ferme le ticket' },
      { name: 'ticket add <@user>', desc: 'Ajoute un utilisateur' },
      { name: 'ticket remove <@user>', desc: 'Retire un utilisateur' },
      { name: 'ticket rename <nom>', desc: 'Renomme le canal' },
      { name: 'ticket list', desc: 'Liste des tickets ouverts' },
      { name: 'ticket claim', desc: 'Assigne le ticket' },
    ]
  },
  access: {
    emoji: '🔑',
    description: 'Système d\'accès aux salons',
    commands: [
      { name: 'access create <id> <#salon>', desc: 'Crée un accès' },
      { name: 'access setrole <id> <@role>', desc: 'Définit le rôle' },
      { name: 'access settype <id> <give|toggle>', desc: 'Type d\'accès' },
      { name: 'access setlabel <id> <texte>', desc: 'Label du bouton' },
      { name: 'access setstyle <id> <style>', desc: 'Style du bouton' },
      { name: 'access list', desc: 'Liste des accès' },
      { name: 'access delete <id>', desc: 'Supprime un accès' },
    ]
  },
  moderation: {
    emoji: '🔨',
    description: 'Commandes de modération',
    commands: [
      { name: 'warn <@user> [raison]', desc: 'Avertit un utilisateur' },
      { name: 'warnings <@user>', desc: 'Liste les warnings' },
      { name: 'clearwarns <@user>', desc: 'Efface tous les warnings' },
      { name: 'delwarn <warn_id>', desc: 'Supprime un warning' },
      { name: 'mute <@user> [durée] [raison]', desc: 'Mute un utilisateur' },
      { name: 'unmute <@user>', desc: 'Démute un utilisateur' },
      { name: 'kick <@user> [raison]', desc: 'Expulse un utilisateur' },
      { name: 'ban <@user> [raison]', desc: 'Bannit un utilisateur' },
      { name: 'unban <user_id>', desc: 'Débannit un utilisateur' },
      { name: 'softban <@user> [raison]', desc: 'Ban + unban immédiat' },
      { name: 'banlist', desc: 'Liste des bans' },
      { name: 'purge <nombre>', desc: 'Supprime des messages' },
      { name: 'slowmode <secondes>', desc: 'Définit le slowmode' },
      { name: 'lock [#salon]', desc: 'Verrouille un salon' },
      { name: 'unlock [#salon]', desc: 'Déverrouille un salon' },
    ]
  },
  roles: {
    emoji: '🎭',
    description: 'Gestion des rôles',
    commands: [
      { name: 'role add <@user> <@role>', desc: 'Donne un rôle' },
      { name: 'role remove <@user> <@role>', desc: 'Retire un rôle' },
      { name: 'role create <nom> [#couleur]', desc: 'Crée un rôle' },
      { name: 'role delete <@role>', desc: 'Supprime un rôle' },
      { name: 'role color <@role> <#couleur>', desc: 'Change la couleur' },
      { name: 'role info <@role>', desc: 'Infos sur un rôle' },
      { name: 'role members <@role>', desc: 'Liste les membres avec ce rôle' },
      { name: 'role hoist <@role>', desc: 'Toggle l\'affichage séparé' },
      { name: 'role mentionable <@role>', desc: 'Toggle la mentionnabilité' },
      { name: 'reactionrole set <msg_id> <emoji> <@role>', desc: 'Reaction role' },
      { name: 'reactionrole remove <msg_id> <emoji>', desc: 'Supprime une association' },
      { name: 'reactionrole list', desc: 'Liste les reaction roles' },
    ]
  },
  custom: {
    emoji: '⚡',
    description: 'Commandes personnalisées',
    commands: [
      { name: 'cc create <nom> <réponse>', desc: 'Crée une commande' },
      { name: 'cc edit <nom> <réponse>', desc: 'Modifie une commande' },
      { name: 'cc delete <nom>', desc: 'Supprime une commande' },
      { name: 'cc list', desc: 'Liste des commandes' },
      { name: 'cc info <nom>', desc: 'Informations' },
      { name: 'cc setembed <nom> <embed_id>', desc: 'Associe un embed' },
    ]
  },
  sondages: {
    emoji: '📊',
    description: 'Sondages avec boutons',
    commands: [
      { name: 'poll create <question>', desc: 'Sondage oui/non' },
      { name: 'poll multichoice <question> | <opt1> | ...', desc: 'Sondage multi-choix' },
      { name: 'poll end <msg_id>', desc: 'Termine un sondage' },
    ]
  }
};

async function cmdHelp(message, args) {
  const prefix = getPrefix(message.guild.id);
  const category = args[0]?.toLowerCase();

  if (!category) {
    // Show all categories
    const embed = new EmbedBuilder()
      .setColor(getDefaultColor(message.guild.id))
      .setTitle('📖 Aide — Toutes les catégories')
      .setDescription(`Préfixe: \`${prefix}\`\n\nUtilisez \`${prefix}help <catégorie>\` pour voir les commandes d'une catégorie.`)
      .setFooter({ text: `${Object.values(helpCategories).reduce((sum, cat) => sum + cat.commands.length, 0)} commandes au total` })
      .setTimestamp();

    for (const [key, cat] of Object.entries(helpCategories)) {
      embed.addFields({
        name: `${cat.emoji} ${key.charAt(0).toUpperCase() + key.slice(1)}`,
        value: `${cat.description} (${cat.commands.length} commandes)`,
        inline: true
      });
    }

    return message.reply({ embeds: [embed] });
  }

  const cat = helpCategories[category];
  if (!cat) {
    const available = Object.keys(helpCategories).join(', ');
    return message.reply({ embeds: [errorEmbed('Catégorie inconnue', `Catégories: ${available}`)] });
  }

  const embed = new EmbedBuilder()
    .setColor(getDefaultColor(message.guild.id))
    .setTitle(`${cat.emoji} ${category.charAt(0).toUpperCase() + category.slice(1)} — Commandes`)
    .setDescription(cat.description)
    .setFooter({ text: `Préfixe: ${prefix} | ${cat.commands.length} commande(s)` })
    .setTimestamp();

  const cmdLines = cat.commands.map(c => `\`${prefix}${c.name}\` — ${c.desc}`);
  // Split into multiple fields if too many commands
  const chunkSize = 10;
  for (let i = 0; i < cmdLines.length; i += chunkSize) {
    const chunk = cmdLines.slice(i, i + chunkSize);
    embed.addFields({
      name: i === 0 ? 'Commandes' : '\u200b',
      value: chunk.join('\n'),
      inline: false
    });
  }

  await message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : EVENTS DISCORD
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`Bot connecté : ${client.user.tag}`);
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  ✅ Bot connecté: ${client.user.tag.padEnd(21)}║`);
  console.log(`║  🌐 Serveurs: ${client.guilds.cache.size.toString().padEnd(26)}║`);
  console.log(`║  👥 Utilisateurs: ${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0).toString().padEnd(22)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  client.user.setPresence({
    activities: [{ name: 'VIP à 3.50€ !!', type: 0 }],
    status: 'online'
  });

  startAutoUnmute();
  startHttpServer();

  await initAllStatsAutoRefresh();
});

client.on('messageCreate', async (message) => {
  try {
    await handleMessage(message);
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ─── Interaction Create ───────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true }); } catch {}
    }
  }
});

// ─── Guild Member Add (Welcome + Autorole) ────────────────────────────────────

client.on('guildMemberAdd', async (member) => {
  try {
    // Autorole
    const autoroleId = getConfig(member.guild.id, 'autorole');
    if (autoroleId) {
      const role = member.guild.roles.cache.get(autoroleId);
      if (role) await member.roles.add(role).catch(() => {});
    }

    // Welcome
    await handleWelcome(member, false);
  } catch (err) {
    console.error('guildMemberAdd error:', err);
  }
});

/**
 * Send welcome message for a member
 * @param {import('discord.js').GuildMember} member
 * @param {boolean} isTest
 */
async function handleWelcome(member, isTest) {
  const welcomeChannelId = getConfig(member.guild.id, 'welcome_channel');
  if (!welcomeChannelId) return;
  const channel = member.guild.channels.cache.get(welcomeChannelId);
  if (!channel) return;

  const rawMsg = getConfig(member.guild.id, 'welcome_message', 'Bienvenue {mention} sur **{server}** ! Tu es le membre n°{count} 🎉');
  const msg = replaceVariables(rawMsg, member);
  const useEmbed = getConfig(member.guild.id, 'welcome_embed', 'true') === 'true';

  if (useEmbed) {
    const embed = new EmbedBuilder()
      .setColor(getDefaultColor(member.guild.id))
      .setTitle('👋 Nouveau membre !')
      .setDescription(msg)
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } else {
    await channel.send(msg);
  }
}

// ─── Reaction Add/Remove (Reaction Roles) ─────────────────────────────────────

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    const guild = reaction.message.guild;
    if (!guild) return;

    const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
    const rr = db.prepare('SELECT role_id FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?').get(guild.id, reaction.message.id, emoji);
    if (!rr) return;

    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.get(rr.role_id);
    if (role && member) await member.roles.add(role);
  } catch (err) {
    console.error('reactionAdd error:', err);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    const guild = reaction.message.guild;
    if (!guild) return;

    const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
    const rr = db.prepare('SELECT role_id FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?').get(guild.id, reaction.message.id, emoji);
    if (!rr) return;

    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.get(rr.role_id);
    if (role && member) await member.roles.remove(role);
  } catch (err) {
    console.error('reactionRemove error:', err);
  }
});

// ─── Guild Member Remove (Log) ────────────────────────────────────────────────

client.on('guildMemberRemove', async (member) => {
  try {
    await sendLog(member.guild, new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('📤 Membre parti')
      .addFields(
        { name: 'Utilisateur', value: `${member.user.tag} (\`${member.id}\`)`, inline: true },
        { name: 'Membres restants', value: `${member.guild.memberCount}`, inline: true }
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp());
  } catch {}
});

// ─── Message Delete (Log) ─────────────────────────────────────────────────────

client.on('messageDelete', async (message) => {
  if (message.author?.bot) return;
  try {
    await sendLog(message.guild, new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🗑️ Message supprimé')
      .addFields(
        { name: 'Auteur', value: `${message.author?.tag || 'Inconnu'} (\`${message.author?.id || 'N/A'}\`)`, inline: true },
        { name: 'Canal', value: `<#${message.channel.id}>`, inline: true },
        { name: 'Contenu', value: message.content?.substring(0, 1000) || '*(vide ou embed)*', inline: false }
      )
      .setTimestamp());
  } catch {}
});

// ─── Message Update (Log) ─────────────────────────────────────────────────────

client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (oldMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  try {
    await sendLog(oldMsg.guild, new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('✏️ Message modifié')
      .addFields(
        { name: 'Auteur', value: `${oldMsg.author?.tag || 'Inconnu'}`, inline: true },
        { name: 'Canal', value: `<#${oldMsg.channel.id}>`, inline: true },
        { name: 'Avant', value: (oldMsg.content || '*(vide)*').substring(0, 500), inline: false },
        { name: 'Après', value: (newMsg.content || '*(vide)*').substring(0, 500), inline: false }
      )
      .setTimestamp());
  } catch {}
});

// ─── Guild Ban Add/Remove (Log) ───────────────────────────────────────────────

client.on('guildBanAdd', async (ban) => {
  try {
    await sendLog(ban.guild, new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🔨 Utilisateur banni')
      .addFields(
        { name: 'Utilisateur', value: `${ban.user.tag} (\`${ban.user.id}\`)`, inline: true },
        { name: 'Raison', value: ban.reason || 'Aucune raison', inline: true }
      )
      .setTimestamp());
  } catch {}
});

client.on('guildBanRemove', async (ban) => {
  try {
    await sendLog(ban.guild, new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('🔓 Utilisateur débanni')
      .addFields({ name: 'Utilisateur', value: `${ban.user.tag} (\`${ban.user.id}\`)`, inline: true })
      .setTimestamp());
  } catch {}
});

// ─── Channel Create/Delete (Log) ─────────────────────────────────────────────

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  try {
    await sendLog(channel.guild, new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('📁 Salon créé')
      .addFields({ name: 'Salon', value: `${channel.name} (\`${channel.id}\`)`, inline: true })
      .setTimestamp());
  } catch {}
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  try {
    await sendLog(channel.guild, new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('📁 Salon supprimé')
      .addFields({ name: 'Salon', value: `${channel.name} (\`${channel.id}\`)`, inline: true })
      .setTimestamp());
  } catch {}
});

// ─── Role Create/Delete (Log) ─────────────────────────────────────────────────

client.on('roleCreate', async (role) => {
  try {
    await sendLog(role.guild, new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('🎭 Rôle créé')
      .addFields({ name: 'Rôle', value: `${role.name} (\`${role.id}\`)`, inline: true })
      .setTimestamp());
  } catch {}
});

client.on('roleDelete', async (role) => {
  try {
    await sendLog(role.guild, new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle('🎭 Rôle supprimé')
      .addFields({ name: 'Rôle', value: `${role.name} (\`${role.id}\`)`, inline: true })
      .setTimestamp());
  } catch {}
});

// ─── Ticket Claim Button ──────────────────────────────
async function ticketClaimFromButton(interaction) {
  try {
    const { guild, channel, user, member } = interaction;

    if (!guild || !channel) {
      return interaction.reply({ content: '❌ Hors serveur.', ephemeral: true });
    }

    const ticket = db
      .prepare('SELECT * FROM tickets WHERE guild_id = ? AND ticket_channel_id = ?')
      .get(guild.id, channel.id);

    if (!ticket) {
      return interaction.reply({ content: '❌ Ce salon n’est pas un ticket.', ephemeral: true });
    }

    // ❌ Empêche le créateur du ticket de claim
if (ticket.user_id === user.id) {
  return interaction.reply({
    content: "❌ Tu ne peux pas claim ton propre ticket.",
    ephemeral: true
  });
}

    if (!isMod(member)) {
      return interaction.reply({ content: '❌ Modérateur requis.', ephemeral: true });
    }

    if (ticket.claimed_by) {
      return interaction.reply({ content: `❌ Déjà claim par <@${ticket.claimed_by}>`, ephemeral: true });
    }

    db.prepare(
      'UPDATE tickets SET claimed_by = ? WHERE guild_id = ? AND ticket_channel_id = ?'
    ).run(user.id, guild.id, channel.id);

    await interaction.reply({
  content: `🛡 ${interaction.user} a pris en charge ce ticket.`,
  allowedMentions: { users: [] }
});

  } catch (err) {
    console.error('❌ Claim Error:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Une erreur est survenue pendant le claim.', ephemeral: true }).catch(() => {});
    }
  }
}

// ─── Error Handling ───────────────────────────────────────────────────────────

client.on('error', (err) => console.error('Client error:', err));
client.on('warn', (warn) => console.warn('Client warn:', warn));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION : DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════

console.log('🚀 Démarrage du bot Discord Ultra-Complet...');
console.log('📦 discord.js v14 | Node.js', process.version);
console.log('🗄️ SQLite (better-sqlite3) initialisé');

client.login(TOKEN).catch((err) => {
  console.error('❌ Erreur de connexion:', err.message);
  console.error('Vérifiez votre TOKEN dans le fichier .env');
  process.exit(1);
});

const cols = db.prepare(`PRAGMA table_info(tickets)`).all();
const hasClaimedBy = cols.some(c => c.name === 'claimed_by');

if (!hasClaimedBy) {
  db.prepare(`ALTER TABLE tickets ADD COLUMN claimed_by TEXT`).run();
  console.log('✔ claimed_by ajouté à tickets');
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId.startsWith('announce_desc_')) {
    const announceId = interaction.customId.replace(
      'announce_desc_',
      ''
    );

    const data = getAnnounce(
      interaction.guild.id,
      announceId
    );

    if (!data) {
      return interaction.reply({
        embeds: [
          errorEmbed(
            'Erreur',
            `Annonce \`${announceId}\` introuvable.`
          )
        ],
        ephemeral: true
      });
    }

    data.description =
      interaction.fields.getTextInputValue('description');

    saveAnnounce(
      interaction.guild.id,
      announceId,
      data
    );

    await interaction.reply({
      embeds: [
        successEmbed(
          interaction.guild.id,
          'Annonce',
          'Description enregistrée.'
        )
      ],
      ephemeral: true
    });
  }
});