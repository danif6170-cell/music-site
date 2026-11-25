// 💬 וואטסאפ ← האתר (ומייל)
// מתחבר לוואטסאפ כ"מכשיר מקושר", אוסף הודעות חדשות ושולח אותן לבוט (גוגל סקריפט),
// שבודק תמונות (בלי נשים) ושולח מייל מסודר. רץ בגיטהאב עד ~5.5 שעות, ואז הבוט מפעיל אותו מחדש.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage,
  fetchLatestBaileysVersion, getContentType, isJidGroup, Browsers } from 'baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

const cp = (() => { try { return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).client_payload || {}; } catch { return {}; } })();
const GAS = cp.callback || process.env.GAS_URL, KEY = cp.key || process.env.BOT_KEY;
const RUN_MS = Number(cp.minutes || 330) * 60 * 1000;   // 5.5 שעות
const AUTH = path.resolve('wa_auth');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(body) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(GAS, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(Object.assign({ key: KEY }, body)) });
      const t = await r.text();
      try { return JSON.parse(t); } catch { throw new Error('bad response ' + t.slice(0, 120)); }
    } catch (e) { log('api fail', body.action, e.message); await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  return {};
}

// --- שמירת החיבור (המפתחות) בדרייב דרך הבוט – כדי שלא צריך לקשר מחדש כל הפעלה
async function loadAuth() {
  fs.rmSync(AUTH, { recursive: true, force: true }); fs.mkdirSync(AUTH, { recursive: true });
  const r = await api({ action: 'waAuthGet' });
  const files = r.files || {};
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(AUTH, n.replace(/[\/\\]/g, '_')), c);
  log('auth files loaded:', Object.keys(files).length);
}
let lastSave = 0, saveTimer = null;
async function saveAuth(final) {
  if (!final && Date.now() - lastSave < 60 * 1000) {        // לכל היותר פעם בדקה
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveAuth(false).catch(() => {}); }, 61 * 1000);
    return;
  }
  lastSave = Date.now();
  const files = {};
  for (const n of fs.readdirSync(AUTH)) files[n] = fs.readFileSync(path.join(AUTH, n), 'utf8');
  await api({ action: 'waAuthPut', files });
}

// --- תור הודעות → הבוט (האתר + מייל מסכם). כשהאתר פתוח – כל כמה שניות, אחרת פעם בדקה
const queue = [];
let fast = false, lastFlush = 0;
async function flush(force) {
  if (!queue.length) return;
  if (!force && Date.now() - lastFlush < (fast ? 4000 : 60000)) return;
  const batch = queue.splice(0, queue.length);
  lastFlush = Date.now();
  const r = await api({ action: 'waIn', msgs: batch });
  if (r.ok) { fast = !!r.fast; log('forwarded', batch.length); } else { log('forward failed – back to queue'); queue.unshift(...batch); }
}
// --- תשובות מהאתר
let lastOut = 0;
async function outbox(sock) {
  if (Date.now() - lastOut < (fast ? 4000 : 45000)) return;
  lastOut = Date.now();
  const r = await api({ action: 'waOut' });
  fast = !!r.fast;
  for (const o of r.out || []) {
    try {
      const res = await sock.sendMessage(o.jid, { text: o.text });
      await api({ action: 'waSent', jid: o.jid, tmp: o.tmp, id: res && res.key && res.key.id });
      log('sent reply');
    } catch (e) { await api({ action: 'waSent', jid: o.jid, tmp: o.tmp, error: e.message }); }
  }
}

const names = {};
async function chatName(sock, jid, fallback) {
  if (names[jid] && !(fallback && names[jid].startsWith('+'))) return names[jid];
  if (isJidGroup(jid)) { try { names[jid] = (await sock.groupMetadata(jid)).subject; } catch { names[jid] = 'קבוצה'; } }
  else names[jid] = fallback || '+' + jid.split('@')[0];
  return names[jid];
}

async function main() {
  const cfg = await api({ action: 'waCfg' });
  if (!cfg.on) { log('whatsapp is off'); return; }
  await loadAuth();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const t0 = Date.now();
  let paired = !!state.creds.registered, done = false, sock;

  const start = () => {
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false,
      browser: Browsers.ubuntu('Chrome'), syncFullHistory: false, printQRInTerminal: false });
    sock.ev.on('creds.update', async () => { await saveCreds(); saveAuth(false).catch(() => {}); });

    sock.ev.on('connection.update', async u => {
      if (u.connection === 'open') { log('connected'); paired = true; api({ action: 'waStatus', state: 'connected' }); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        log('closed', code);
        if (code === DisconnectReason.loggedOut) {
          await api({ action: 'waStatus', state: 'loggedout' });
          await api({ action: 'waAuthPut', files: {} });   // מוחקים – בפעם הבאה מקשרים מחדש
          done = true; return;
        }
        if (!done) setTimeout(start, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try {
          const jid = m.key.remoteJid;
          if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
          const ts = Number(m.messageTimestamp || 0) * 1000;
          if (type !== 'notify' && !(m.key.fromMe && Date.now() - ts < 5 * 60000)) continue;   // היסטוריה ישנה – לא
          const group = isJidGroup(jid);
          if (group && !cfg.groups) continue;
          const t = getContentType(m.message || {});
          if (!t || /protocolMessage|reactionMessage|senderKeyDistribution/.test(t)) continue;
          const msg = m.message[t] || {};
          const it = {
            id: m.key.id, jid, me: !!m.key.fromMe, chat: await chatName(sock, jid, group || m.key.fromMe ? '' : m.pushName), group: !!group,
            from: m.pushName || '', time: Number(m.messageTimestamp || Date.now() / 1000) * 1000,
            text: m.message.conversation || msg.text || msg.caption || ''
          };
          const dl = async max => {
            if (Number(msg.fileLength || 0) > max) return null;
            const b = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
            return b.length <= max ? b.toString('base64') : null;
          };
          if (t === 'imageMessage' || (t === 'documentMessage' && /^image\//.test(msg.mimetype || ''))) {
            it.img = await dl(4e6); it.type = msg.mimetype || 'image/jpeg'; if (!it.img) it.note = '🖼️ תמונה גדולה – פתח בוואטסאפ';
          } else if (t === 'audioMessage') {
            it.file = await dl(6e6); it.type = msg.mimetype || 'audio/ogg'; it.fname = 'הודעה קולית.ogg';
            if (!it.file) it.note = '🎤 הודעה קולית ארוכה – פתח בוואטסאפ';
          } else if (t === 'documentMessage') {
            it.file = await dl(8e6); it.type = msg.mimetype || 'application/octet-stream'; it.fname = msg.fileName || 'קובץ';
            if (!it.file) it.note = '📎 קובץ גדול: ' + (msg.fileName || '') + ' – פתח בוואטסאפ';
          } else if (t === 'videoMessage') {
            it.note = '🎬 סרטון – לא נשלח במייל'; if (msg.jpegThumbnail) { it.img = Buffer.from(msg.jpegThumbnail).toString('base64'); it.type = 'image/jpeg'; it.thumb = true; }
          } else if (t === 'stickerMessage') { it.note = '🙂 מדבקה';
          } else if (t === 'locationMessage' || t === 'liveLocationMessage') { it.note = '📍 מיקום: https://maps.google.com/?q=' + msg.degreesLatitude + ',' + msg.degreesLongitude;
          } else if (t === 'contactMessage') { it.note = '👤 איש קשר: ' + (msg.displayName || '');
          } else if (!it.text) { it.note = '(' + t.replace('Message', '') + ')'; }
          queue.push(it);
        } catch (e) { log('msg error', e.message); }
      }
    });
  };
  start();

  // קישור ראשון: קוד בן 8 תווים במייל → וואטסאפ ← מכשירים מקושרים ← קישור עם מספר טלפון
  if (!paired) {
    await new Promise(r => setTimeout(r, 4000));
    const phone = String(cfg.phone || '').replace(/\D/g, '').replace(/^0/, '972');
    if (!phone) { await api({ action: 'waStatus', state: 'nophone' }); return; }
    for (let i = 0; i < 3 && !paired; i++) {
      try {
        const code = await sock.requestPairingCode(phone);
        log('pairing code sent');
        await api({ action: 'waStatus', state: 'pairing', code });
      } catch (e) { log('pair error', e.message); }
      for (let s = 0; s < 150 && !paired; s++) await new Promise(r => setTimeout(r, 2000));
    }
    if (!paired) { await api({ action: 'waStatus', state: 'pairfail' }); done = true; try { sock.end(); } catch {} return; }
  }

  while (!done && Date.now() - t0 < RUN_MS) {
    await new Promise(r => setTimeout(r, fast ? 3000 : 15000));
    await flush(false).catch(e => log('flush', e.message));
    await outbox(sock).catch(e => log('outbox', e.message));
    if (Date.now() - (globalThis.hb || 0) > 120000) { globalThis.hb = Date.now(); api({ action: 'waStatus', state: 'connected' }).catch(() => {}); }   // דופק
    saveAuth(false).catch(() => {});
  }
  done = true;
  await flush(true).catch(() => {});
  await saveAuth(true).catch(() => {});
  try { sock.end(); } catch {}
  log('bye');
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
