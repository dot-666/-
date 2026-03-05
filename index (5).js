/**
 * WhatsApp MD Bot - Main Entry Point
 */
process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/tmp/puppeteer_cache_disabled';

const { initializeTempSystem } = require('./utils/tempManager');
const { startCleanup } = require('./utils/cleanup');
initializeTempSystem();
startCleanup();
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

const forbiddenPatternsConsole = [
  'closing session',
  'closing open session',
  'sessionentry',
  'prekey bundle',
  'pendingprekey',
  '_chains',
  'registrationid',
  'currentratchet',
  'chainkey',
  'ratchet',
  'signal protocol',
  'ephemeralkeypair',
  'indexinfo',
  'basekey'
];

console.log = (...args) => {
  const message = args.map(a => typeof a === 'string' ? a : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').toLowerCase();
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleLog.apply(console, args);
  }
};

console.error = (...args) => {
  const message = args.map(a => typeof a === 'string' ? a : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').toLowerCase();
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleError.apply(console, args);
  }
};

console.warn = (...args) => {
  const message = args.map(a => typeof a === 'string' ? a : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ').toLowerCase();
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleWarn.apply(console, args);
  }
};

// Now safe to load libraries
const pino = require('pino');
const chalk = require('chalk');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  delay
} = require('@whiskeysockets/baileys');
const config = require('./config');
const handler = require('./handler');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const readline = require("readline");
const NodeCache = require("node-cache");

// Custom logging function with colors
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = chalk.cyan.bold('[BOT-MD]');
    
    const colors = {
        info: chalk.blue,
        success: chalk.green,
        warning: chalk.yellow,
        error: chalk.red,
        pairing: chalk.magenta,
        session: chalk.cyan,
        connection: chalk.greenBright,
        system: chalk.gray
    };
    
    const colorFunc = colors[type] || chalk.white;
    
    if (message.includes('\n') || message.includes('════')) {
        console.log(`${prefix} ${colorFunc(message)}`);
    } else {
        console.log(`${prefix} ${colorFunc('➜')} ${colorFunc(message)}`);
    }
}

// Session paths
const sessionDir = path.join(__dirname, config.sessionName || 'session');
const credsPath = path.join(sessionDir, 'creds.json');
const loginFile = path.join(sessionDir, 'login.json');

// Readline setup
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const question = (text) => rl ? new Promise(resolve => rl.question(chalk.cyan(text), resolve)) : Promise.resolve(null);

// Login persistence functions
async function saveLoginMethod(method) {
    await fs.promises.mkdir(sessionDir, { recursive: true });
    await fs.promises.writeFile(loginFile, JSON.stringify({ method }, null, 2));
}

async function getLastLoginMethod() {
    if (fs.existsSync(loginFile)) {
        const data = JSON.parse(fs.readFileSync(loginFile, 'utf-8'));
        return data.method;
    }
    return null;
}

function sessionExists() {
    return fs.existsSync(credsPath);
}

// Clear session files
function clearSessionFiles() {
    try {
        log('🧹 Cleaning session folder...', 'warning');
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        if (fs.existsSync(loginFile)) fs.unlinkSync(loginFile);
        log('✅ Session files cleaned successfully.', 'success');
    } catch (e) {
        log(`Failed to clear session files: ${e.message}`, 'error');
    }
}

// FIXED: Improved UltraS2 session extraction with better error handling
async function checkUltraS2Session() {
    if (config.sessionID && config.sessionID.startsWith('UltraS2::~')) {
        try {
            const base64Data = config.sessionID.split('UltraS2::~')[1];
            
            if (!base64Data) {
                throw new Error("❌ Invalid session format. Expected 'UltraS2::~[base64]'");
            }

            // Ensure session directory exists
            if (!fs.existsSync(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
            }

            // Try to decompress the data
            let decompressedData;
            try {
                const compressedData = Buffer.from(base64Data, 'base64');
                decompressedData = zlib.gunzipSync(compressedData);
            } catch (decompressErr) {
                // If decompression fails, try without decompression (maybe it's not compressed)
                log('⚠️ Decompression failed, trying raw base64...', 'warning');
                decompressedData = Buffer.from(base64Data, 'base64').toString('utf8');
            }

            // Validate that it's valid JSON (creds.json should be JSON)
            try {
                JSON.parse(decompressedData);
            } catch (jsonErr) {
                throw new Error('Invalid session data: not valid JSON');
            }

            // Write the session file
            fs.writeFileSync(credsPath, decompressedData, 'utf8');
            log('📡 Session: 🔑 Successfully loaded from UltraS2 Session', 'session');
            
            // FIXED: Don't send notification immediately - wait for actual connection
            // Just log success and continue
            return true;
            
        } catch (e) {
            log(`📡 Session: ❌ Error processing UltraS2 session: ${e.message}`, 'error');
            // If session is invalid, clean it up
            if (fs.existsSync(credsPath)) {
                fs.unlinkSync(credsPath);
            }
        }
    }
    return false;
}

// Get login method interactively
async function getLoginMethod() {
    const lastMethod = await getLastLoginMethod();
    if (lastMethod && sessionExists()) {
        log(`Last login method detected: ${lastMethod}. Using it automatically.`, 'info');
        return lastMethod;
    }
    
    if (!sessionExists() && fs.existsSync(loginFile)) {
        log('Session files missing. Removing old login preference for clean re-login.', 'warning');
        fs.unlinkSync(loginFile);
    }

    if (!process.stdin.isTTY) {
        log("❌ No session found and not in interactive mode.", 'error');
        process.exit(1);
    }

    console.log(chalk.cyan.bold('\n╔════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('║        LOGIN METHOD SELECTION      ║'));
    console.log(chalk.cyan.bold('╠════════════════════════════════════╣'));
    console.log(chalk.cyan.bold('║  ') + chalk.white('1. ') + chalk.yellow('WhatsApp Number ') + chalk.gray('[Pairing Code]'));
    console.log(chalk.cyan.bold('║  ') + chalk.white('2. ') + chalk.yellow('Use Session ID    ') + chalk.gray('[UltraS2 Format]'));
    console.log(chalk.cyan.bold('╚════════════════════════════════════╝\n'));

    let choice = await question(chalk.greenBright("➜ Enter option number (1 or 2): "));
    choice = choice.trim();

    if (choice === '1') {
        console.log(chalk.cyan.bold('\n╔════════════════════════════════════╗'));
        console.log(chalk.cyan.bold('║       PAIRING CODE LOGIN          ║'));
        console.log(chalk.cyan.bold('╚════════════════════════════════════╝\n'));
        
        let phone = await question(chalk.greenBright("➜ Enter your WhatsApp number (e.g., 254798570132): "));
        phone = phone.replace(/[^0-9]/g, '');
        const PhoneNumber = require('awesome-phonenumber');
        if (!PhoneNumber('+' + phone).isValid()) { 
            log('❌ Invalid phone number. Please try again.', 'error'); 
            return getLoginMethod(); 
        }
        global.phoneNumber = phone;
        await saveLoginMethod('number');
        return 'number';
    } else if (choice === '2') {
        console.log(chalk.cyan.bold('\n╔════════════════════════════════════╗'));
        console.log(chalk.cyan.bold('║        SESSION ID LOGIN            ║'));
        console.log(chalk.cyan.bold('╚════════════════════════════════════╝\n'));
        log('📝 Session ID format: ' + chalk.yellow('UltraS2::~[base64]'), 'info');
        
        let sessionId = await question(chalk.greenBright("➜ Paste your Session ID here: "));
        sessionId = sessionId.trim();
        
        // Check format
        if (!sessionId.startsWith('UltraS2::~')) {
            log('❌ Invalid Session ID format! Must start with ' + chalk.yellow('UltraS2::~'), 'error');
            return getLoginMethod();
        }
        
        global.SESSION_ID = sessionId;
        await saveLoginMethod('session');
        return 'session';
    } else {
        log("❌ Invalid option! Please choose 1 or 2.", 'error');
        return getLoginMethod();
    }
}

// FIXED: Request pairing code without automatic notification
async function requestPairingCode(socket) {
    try {
        log("⏳ Waiting 3 seconds for socket stabilization...", 'warning');
        await delay(3000);

        let code = await socket.requestPairingCode(global.phoneNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        
        console.log(chalk.cyan.bold('\n╔════════════════════════════════════╗'));
        console.log(chalk.cyan.bold('║        PAIRING CODE GENERATED      ║'));
        console.log(chalk.cyan.bold('╠════════════════════════════════════╣'));
        console.log(chalk.cyan.bold('║  ') + chalk.white('Code: ') + chalk.bgGreen.black(`  ${code}  `));
        console.log(chalk.cyan.bold('║  ') + chalk.white('Phone: ') + chalk.yellow(global.phoneNumber));
        console.log(chalk.cyan.bold('║  ') + chalk.white('Expires: ') + chalk.gray('5 minutes'));
        console.log(chalk.cyan.bold('╚════════════════════════════════════╝\n'));
        
        log(`
📱 INSTRUCTIONS:
${chalk.white('1.')} ${chalk.yellow('Open WhatsApp on your phone')}
${chalk.white('2.')} ${chalk.yellow('Go to Settings')} ${chalk.gray('→')} ${chalk.yellow('Linked Devices')}
${chalk.white('3.')} ${chalk.yellow('Tap')} ${chalk.green('"Link a Device"')}
${chalk.white('4.')} ${chalk.yellow('Enter the code:')} ${chalk.bgGreen.black(` ${code} `)}
        `, 'pairing');
        
        // FIXED: Remove automatic notification - let user scan manually
        // Just log success and continue
        log('⏳ Waiting for you to enter the code on your phone...', 'info');
        
        return true;
    } catch (err) { 
        log(`❌ Failed to get pairing code: ${err.message}`, 'error'); 
        return false; 
    }
}

// FIXED: Improved session download with better validation
async function downloadSessionData() {
    try {
        await fs.promises.mkdir(sessionDir, { recursive: true });
        
        if (!fs.existsSync(credsPath) && global.SESSION_ID) {
            log('📥 Downloading session data...', 'info');
            
            const base64Data = global.SESSION_ID.split('UltraS2::~')[1];
            
            if (!base64Data) {
                throw new Error('Invalid Session ID format');
            }
            
            // Try to decompress, fallback to raw base64
            let sessionData;
            try {
                const compressedData = Buffer.from(base64Data, 'base64');
                sessionData = zlib.gunzipSync(compressedData);
            } catch (decompressErr) {
                log('⚠️ Session not compressed, using raw base64...', 'warning');
                sessionData = Buffer.from(base64Data, 'base64');
            }
            
            // Validate it's valid JSON
            try {
                JSON.parse(sessionData.toString('utf8'));
            } catch (jsonErr) {
                throw new Error('Invalid session data: not valid JSON');
            }
            
            await fs.promises.writeFile(credsPath, sessionData);
            log('✅ Session successfully saved.', 'success');
            
            // FIXED: Remove automatic notification
            // Just log success
        }
    } catch (err) { 
        log(`❌ Error downloading session data: ${err.message}`, 'error');
        // Clean up invalid session file if it was created
        if (fs.existsSync(credsPath)) {
            fs.unlinkSync(credsPath);
        }
    }
}

// FIXED: Removed createTempSocket function as it's not needed for notifications
// We'll just use the main socket for any needed notifications

// Remove Puppeteer cache
function cleanupPuppeteerCache() {
  try {
    const home = os.homedir();
    const cacheDir = path.join(home, '.cache', 'puppeteer');

    if (fs.existsSync(cacheDir)) {
      log('🧹 Removing Puppeteer cache...', 'warning');
      fs.rmSync(cacheDir, { recursive: true, force: true });
      log('✅ Puppeteer cache removed', 'success');
    }
  } catch (err) {
    log(`⚠️ Failed to cleanup Puppeteer cache: ${err.message}`, 'error');
  }
}

// Optimized in-memory store
const store = {
  messages: new Map(),
  maxPerChat: 20,

  bind: (ev) => {
    ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key?.id) continue;

        const jid = msg.key.remoteJid;
        if (!store.messages.has(jid)) {
          store.messages.set(jid, new Map());
        }

        const chatMsgs = store.messages.get(jid);
        chatMsgs.set(msg.key.id, msg);

        if (chatMsgs.size > store.maxPerChat) {
          const oldestKey = chatMsgs.keys().next().value;
          chatMsgs.delete(oldestKey);
        }
      }
    });
  },

  loadMessage: async (jid, id) => {
    return store.messages.get(jid)?.get(id) || null;
  }
};

// Message deduplication with size limit
const processedMessages = new Set();
const MAX_CACHE_SIZE = 10000; // Limit cache size to prevent memory leaks

setInterval(() => {
  const size = processedMessages.size;
  processedMessages.clear();
  log(`🧹 Processed messages cache cleared (was ${size} messages)`, 'system');
}, 5 * 60 * 1000);

// Also clear if cache gets too large
function addToProcessedCache(msgId) {
  if (processedMessages.size >= MAX_CACHE_SIZE) {
    // Clear oldest 20% when cache is full
    const toDelete = Math.floor(MAX_CACHE_SIZE * 0.2);
    const iterator = processedMessages.values();
    for (let i = 0; i < toDelete; i++) {
      processedMessages.delete(iterator.next().value);
    }
  }
  processedMessages.add(msgId);
}

// Custom Pino logger
const createSuppressedLogger = (level = 'silent') => {
  const forbiddenPatterns = [
    'closing session', 'closing open session', 'sessionentry', 'prekey bundle',
    'pendingprekey', '_chains', 'registrationid', 'currentratchet', 'chainkey',
    'ratchet', 'signal protocol', 'ephemeralkeypair', 'indexinfo', 'basekey',
    'sessionentry', 'ratchetkey'
  ];

  let logger;
  try {
    logger = pino({
      level,
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname' }
      },
      redact: ['registrationId', 'ephemeralKeyPair', 'rootKey', 'chainKey', 'baseKey']
    });
  } catch (err) {
    logger = pino({ level });
  }

  const originalInfo = logger.info.bind(logger);
  logger.info = (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').toLowerCase();
    if (!forbiddenPatterns.some(pattern => msg.includes(pattern))) {
      originalInfo(...args);
    }
  };
  logger.debug = () => { };
  logger.trace = () => { };
  return logger;
};

// Main connection function
async function startBot() {
  log('🔄 Connecting to WhatsApp...', 'connection');
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const msgRetryCounterCache = new NodeCache();

  // Use suppressed logger
  const suppressedLogger = createSuppressedLogger('silent');

  const sock = makeWASocket({
    version,
    logger: suppressedLogger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Edge'),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
    },
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
        let msg = await store.loadMessage(key.remoteJid, key.id);
        return msg?.message || "";
    },
    msgRetryCounterCache,
    defaultQueryTimeoutMs: 60000, // Add timeout to prevent hanging
  });

  // Bind store
  store.bind(sock.ev);

  // Watchdog for inactive socket
  let lastActivity = Date.now();
  const INACTIVITY_TIMEOUT = 30 * 60 * 1000;

  sock.ev.on('messages.upsert', () => {
    lastActivity = Date.now();
  });

  const watchdogInterval = setInterval(async () => {
    if (Date.now() - lastActivity > INACTIVITY_TIMEOUT && sock.ws.readyState === 1) {
      log('⚠️ No activity detected. Forcing reconnect...', 'warning');
      await sock.end(undefined, undefined, { reason: 'inactive' });
      clearInterval(watchdogInterval);
      setTimeout(() => startBot(), 5000);
    }
  }, 5 * 60 * 1000);

  // Connection update handler
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      clearInterval(watchdogInterval);
      
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

      if (statusCode === 515 || statusCode === 503 || statusCode === 408) {
        log(`⚠️ Connection closed (${statusCode}). Reconnecting...`, 'warning');
      } else if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        log('💥 Disconnected! Logged out. Cleaning session...', 'error');
        
        // FIXED: Only log logout, don't send notification
        clearSessionFiles();
        log('Initiating restart in 5 seconds...', 'warning');
        await delay(5000);
        process.exit(1);
      } else {
        log(`Connection closed due to: ${errorMessage}`, 'warning');
      }

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    } else if (connection === 'open') {
      log('╔════════════════════════════════════╗', 'success');
      log('║     ✅ BOT CONNECTED SUCCESSFULLY   ║', 'success');
      log('╠════════════════════════════════════╣', 'success');
      log(`║ 📱 Number: ${sock.user.id.split(':')[0]}`, 'success');
      log(`║ 🤖 Name: ${config.botName}`, 'success');
      log(`║ ⚡ Prefix: ${config.prefix}`, 'success');
      const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
      log(`║ 👑 Owner: ${ownerNames}`, 'success');
      log('╚════════════════════════════════════╝\n', 'success');

      // FIXED: Remove automatic notification to owner
      // Just log success to console

      // Set bot status
      if (config.autoBio) {
        try {
          await sock.updateProfileStatus(`${config.botName} | Active 24/7`);
        } catch (bioErr) {
          // Silently fail if status update fails
        }
      }

      // Initialize anti-call feature
      if (handler.initializeAntiCall) {
        handler.initializeAntiCall(sock);
      }

      // Cleanup old chats
      const now = Date.now();
      for (const [jid, chatMsgs] of store.messages.entries()) {
        const timestamps = Array.from(chatMsgs.values()).map(m => m.messageTimestamp * 1000 || 0);
        if (timestamps.length > 0 && now - Math.max(...timestamps) > 24 * 60 * 60 * 1000) {
          store.messages.delete(jid);
        }
      }
      log(`🧹 Store cleaned. Active chats: ${store.messages.size}`, 'system');
    }
  });

  // Credentials update handler
  sock.ev.on('creds.update', saveCreds);

  // System JID filter
  const isSystemJid = (jid) => {
    if (!jid) return true;
    return jid.includes('@broadcast') ||
      jid.includes('status.broadcast') ||
      jid.includes('@newsletter') ||
      jid.includes('@newsletter.');
  };

  // Messages handler
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || !msg.key?.id) continue;

      const from = msg.key.remoteJid;
      if (!from) continue;

      if (isSystemJid(from)) continue;

      const msgId = msg.key.id;
      if (processedMessages.has(msgId)) continue;

      const MESSAGE_AGE_LIMIT = 5 * 60 * 1000;
      if (msg.messageTimestamp) {
        const messageAge = Date.now() - (msg.messageTimestamp * 1000);
        if (messageAge > MESSAGE_AGE_LIMIT) continue;
      }

      // Add to cache with size limit
      addToProcessedCache(msgId);

      if (msg.key && msg.key.id) {
        if (!store.messages.has(from)) {
          store.messages.set(from, new Map());
        }
        const chatMsgs = store.messages.get(from);
        chatMsgs.set(msg.key.id, msg);

        if (chatMsgs.size > store.maxPerChat) {
          const sortedIds = Array.from(chatMsgs.entries())
            .sort((a, b) => (a[1].messageTimestamp || 0) - (b[1].messageTimestamp || 0))
            .map(([id]) => id);
          for (let i = 0; i < sortedIds.length - store.maxPerChat; i++) {
            chatMsgs.delete(sortedIds[i]);
          }
        }
      }

      // Handle message
      handler.handleMessage(sock, msg).catch(err => {
        if (!err.message?.includes('rate-overlimit') &&
          !err.message?.includes('not-authorized')) {
          log(`Error handling message: ${err.message}`, 'error');
        }
      });

      // Auto-read and anti-link in next tick
      setImmediate(async () => {
        if (config.autoRead && from.endsWith('@g.us')) {
          try {
            await sock.readMessages([msg.key]);
          } catch (e) {}
        }
        if (from.endsWith('@g.us') && handler.handleAntilink) {
          try {
            const groupMetadata = await handler.getGroupMetadata(sock, msg.key.remoteJid);
            if (groupMetadata) {
              await handler.handleAntilink(sock, msg, groupMetadata);
            }
          } catch (error) {}
        }
      });
    }
  });

  // Silent handlers for other events
  sock.ev.on('message-receipt.update', () => {});
  sock.ev.on('messages.update', () => {});

  // Group participant updates
  if (handler.handleGroupUpdate) {
    sock.ev.on('group-participants.update', async (update) => {
      await handler.handleGroupUpdate(sock, update);
    });
  }

  // Error handler
  sock.ev.on('error', (error) => {
    const statusCode = error?.output?.statusCode;
    if (statusCode === 515 || statusCode === 503 || statusCode === 408) {
      return;
    }
    log(`Socket error: ${error.message}`, 'error');
  });

  return sock;
}

// Main login flow
async function initialize() {
  console.log(chalk.cyan.bold('\n╔════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║      🚀 BOT - MD STARTING          ║'));
  console.log(chalk.cyan.bold('╠════════════════════════════════════╣'));
  console.log(chalk.cyan.bold(`║ 📦 Name: ${config.botName.padEnd(21)}`));
  console.log(chalk.cyan.bold(`║ ⚡ Prefix: ${config.prefix.padEnd(19)}`));
  const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
  console.log(chalk.cyan.bold(`║ 👑 Owner: ${ownerNames.padEnd(20)}`));
  console.log(chalk.cyan.bold('╚════════════════════════════════════╝\n'));

  // Cleanup Puppeteer cache
  cleanupPuppeteerCache();

  // Check for UltraS2 session first
  const ultraS2SessionUsed = await checkUltraS2Session();
  
  if (!ultraS2SessionUsed) {
    // If no valid session exists, go through login flow
    if (!sessionExists()) {
      const loginMethod = await getLoginMethod();
      
      if (loginMethod === 'session') {
        await downloadSessionData();
      } else if (loginMethod === 'number') {
        // Create socket first for pairing
        log('🔄 Creating temporary socket for pairing...', 'connection');
        const tempSock = await startBot();
        await requestPairingCode(tempSock);
        return; // Let the socket continue
      }
    }
  }

  // Start the bot
  startBot().catch(err => {
    log(`❌ Error starting bot: ${err.message}`, 'error');
    process.exit(1);
  });
}

// Start initialization
initialize();

// Process handlers
process.on('uncaughtException', (err) => {
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    log('⚠️ ENOSPC Error: No space left on device. Attempting cleanup...', 'error');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    log('⚠️ Cleanup completed. Bot will continue but may experience issues until space is freed.', 'warning');
    return;
  }
  log(`❌ Uncaught Exception: ${err.message}`, 'error');
});

process.on('unhandledRejection', (err) => {
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    log('⚠️ ENOSPC Error in promise: No space left on device. Attempting cleanup...', 'error');
    const { cleanupOldFiles } = require('./utils/cleanup');
    cleanupOldFiles();
    log('⚠️ Cleanup completed. Bot will continue but may experience issues until space is freed.', 'warning');
    return;
  }

  if (err.message && err.message.includes('rate-overlimit')) {
    log('⚠️ Rate limit reached. Please slow down your requests.', 'warning');
    return;
  }
  log(`❌ Unhandled Rejection: ${err.message}`, 'error');
});

// Export store
module.exports = { store };