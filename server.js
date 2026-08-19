import { Client, GatewayIntentBits, ChannelType, Partials } from 'discord.js';
import { Server } from 'socket.io';
import { Server as Engine } from '@socket.io/bun-engine';
import { join } from 'path';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_DISCORD_BOT_TOKEN';
const CATEGORY_ID = process.env.CATEGORY_ID || 'YOUR_TARGET_CATEGORY_ID';
const PORT = Number(process.env.PORT) || 3042;

// ---------- Discord bot ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

const webhookCache = new Map();

async function getOrCreateWebhook(channel) {
  if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);

  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find(wh => wh.owner?.id === client.user?.id);

  if (!webhook) {
    webhook = await channel.createWebhook({
      name: 'Cuban Relay Webhook',
      reason: 'Relay service for low-bandwidth web app'
    });
  }

  webhookCache.set(channel.id, webhook);
  return webhook;
}

function invalidateWebhook(channelId) {
  webhookCache.delete(channelId);
}

function getCategoryChannels() {
  const categoryChannel = client.channels.cache.get(CATEGORY_ID);
  if (!categoryChannel || categoryChannel.type !== ChannelType.GuildCategory) {
    return { categoryName: 'Unknown Category', channels: [] };
  }

  const channels = categoryChannel.children.cache
    .filter(ch => ch.type === ChannelType.GuildText)
    .sort((a, b) => a.position - b.position)
    .map(ch => ({ id: ch.id, name: ch.name }));

  return { categoryName: categoryChannel.name, channels };
}

function broadcastCategoryUpdate() {
  io.emit('category_updated', getCategoryChannels());
}

function isValidTargetChannel(channel) {
  return channel &&
    channel.type === ChannelType.GuildText &&
    channel.parentId === CATEGORY_ID;
}

function buildMessagePayload(message) {
  const user =
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username ||
    'Unknown';

  return {
    id: message.id,
    channelId: message.channelId,
    user,
    avatar: message.author.displayAvatarURL({ extension: 'png', size: 64 }),
    timestamp: message.createdAt.toISOString(),
    text: message.content || '',
    mediaUrl: message.attachments.first()?.url || null
  };
}

client.once('ready', () => {
  console.log(`Bot connected as ${client.user?.tag}`);
});

client.on('channelCreate', (channel) => {
  if (channel.parentId === CATEGORY_ID) broadcastCategoryUpdate();
});

client.on('channelDelete', (channel) => {
  if (channel.parentId === CATEGORY_ID || webhookCache.has(channel.id)) {
    invalidateWebhook(channel.id);
    broadcastCategoryUpdate();
  }
});

client.on('channelUpdate', (oldCh, newCh) => {
  if (newCh.parentId === CATEGORY_ID || oldCh.parentId === CATEGORY_ID) {
    if (oldCh.parentId === CATEGORY_ID && newCh.parentId !== CATEGORY_ID) {
      invalidateWebhook(newCh.id);
    }
    broadcastCategoryUpdate();
  }
});

client.on('messageCreate', (message) => {
  if (!isValidTargetChannel(message.channel)) return;
  if (!message.content && message.attachments.size === 0) return;
  io.emit('new_message', buildMessagePayload(message));
});

// ---------- Socket.IO with official Bun engine ----------
const io = new Server({
  cors: { origin: '*' }
});

const engine = new Engine({
  path: '/socket.io/',
  cors: { origin: '*' }
});

io.bind(engine);

io.on('connection', (socket) => {
  console.log(`Web client connected: ${socket.id}`);

  socket.emit('init_data', getCategoryChannels());

  socket.on('get_history', async ({ channelId }) => {
    try {
      const channel = client.channels.cache.get(channelId);
      if (!isValidTargetChannel(channel)) {
        socket.emit('channel_history', { channelId, messages: [] });
        return;
      }

      const fetched = await channel.messages.fetch({ limit: 50 });
      const messages = [...fetched.values()].reverse().map(buildMessagePayload);
      socket.emit('channel_history', { channelId, messages });
    } catch (err) {
      console.error('Failed to fetch history:', err);
      socket.emit('channel_history', { channelId, messages: [] });
    }
  });

  socket.on('send_message', async ({ channelId, user, avatar, text }) => {
    try {
      const channel = client.channels.cache.get(channelId);
      if (!isValidTargetChannel(channel)) {
        console.warn(`Access denied for channel ${channelId}`);
        return;
      }

      const content = (text || '').trim().slice(0, 2000);
      if (!content) return;

      const webhook = await getOrCreateWebhook(channel);
      await webhook.send({
        content,
        username: (user || 'Anonymous').slice(0, 80),
        avatarURL: avatar || undefined
      });
    } catch (err) {
      console.error('Failed to send via webhook:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Web client disconnected: ${socket.id}`);
  });
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});

// ---------- Bun native HTTP server ----------
const publicDir = join(import.meta.dir, 'public');

export default {
  port: PORT,
  idleTimeout: 30,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/socket.io/')) {
      return engine.handleRequest(req, server);
    }

    const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(join(publicDir, filePath));

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response('Not Found', { status: 404 });
  },

  websocket: engine.handler().websocket
};

console.log(`Relay server live on port ${PORT} (Bun + @socket.io/bun-engine)`);