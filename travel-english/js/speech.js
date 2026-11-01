/* =========================================================
 * speech.js — 語音播放（speechSynthesis）與語音辨識（SpeechRecognition）
 * ========================================================= */

/* ---------------- 語音播放 TTS ---------------- */

const synth = window.speechSynthesis;
export const ttsSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

export const RATE_NORMAL = 0.95;
export const RATE_SLOW = 0.6;

let voices = [];
function loadVoices() {
  if (!ttsSupported) return;
  voices = synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
}
if (ttsSupported) {
  loadVoices();
  // 很多瀏覽器的語音清單是非同步載入的
  synth.addEventListener?.('voiceschanged', loadVoices);
}

// 依角色挑英文語音：優先 en-US，店員和客人盡量用不同聲音
function pickVoice(role) {
  if (!voices.length) loadVoices();
  const us = voices.filter((v) => /en[-_]US/i.test(v.lang));
  const pool = us.length ? us : voices;
  if (!pool.length) return null;
  // 優先挑音質較好的語音
  const preferred = ['Google US English', 'Samantha', 'Microsoft Aria', 'Microsoft Jenny', 'Alex'];
  const sorted = [...pool].sort((a, b) => score(b) - score(a));
  function score(v) {
    const i = preferred.findIndex((p) => v.name.includes(p));
    return (i === -1 ? 0 : 10 - i) + (v.localService ? 1 : 0);
  }
  if (role === 'customer' && sorted.length > 1) return sorted[1];
  return sorted[0];
}

let speakToken = 0; // 用來中斷「整段播放」

/**
 * 播放一句英文，回傳 Promise（播完才 resolve）
 * @param {string} text
 * @param {{slow?: boolean, role?: string}} opt
 */
export function speak(text, { slow = false, role = 'staff' } = {}) {
  return new Promise((resolve) => {
    if (!ttsSupported) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = slow ? RATE_SLOW : RATE_NORMAL;
    const v = pickVoice(role);
    if (v) u.voice = v;
    // 只有一種語音時，用音高區分角色
    u.pitch = role === 'customer' ? 1.15 : 1.0;

    let finished = false;
    const done = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(ok);
    };
    u.onend = () => done(true);
    u.onerror = () => done(false);
    // 保險：某些瀏覽器偶爾不觸發 onend
    const timer = setTimeout(() => done(true), 2000 + text.length * (slow ? 160 : 100));

    // 先停掉正在播的；Chrome 在 cancel 後立刻 speak 偶爾會沒聲音，所以稍等一下
    if (synth.speaking || synth.pending) {
      synth.cancel();
      setTimeout(() => synth.speak(u), 80);
    } else {
      synth.speak(u);
    }
    synth.resume(); // 某些 Chrome 版本會卡在暫停狀態
  });
}

/**
 * 依序播放多句（例如整段對話）
 * @param {{en:string, role:string}[]} lines
 * @param {(i:number)=>void} onLine 每播一句前呼叫（用來高亮）
 * @returns {Promise<boolean>} 是否完整播完（被中斷回傳 false）
 */
export async function speakAll(lines, { slow = false, onLine } = {}) {
  const token = ++speakToken;
  for (let i = 0; i < lines.length; i++) {
    if (token !== speakToken) return false;
    onLine?.(i);
    await speak(lines[i].en, { slow, role: lines[i].role });
    if (token !== speakToken) return false;
    await new Promise((r) => setTimeout(r, 350)); // 句子間稍微停頓
  }
  return token === speakToken;
}

export function stopSpeaking() {
  speakToken++;
  if (ttsSupported) synth.cancel();
}

/* ---------------- 語音辨識 STT ---------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const sttSupported = !!SR;

let current = null;

/**
 * 開始聽使用者說話，回傳 Promise<string[]>（可能的辨識結果，最多 5 個）
 * 失敗時 reject，error.message 是中文說明
 */
export function listen() {
  return new Promise((resolve, reject) => {
    if (!SR) return reject(new Error('你的瀏覽器不支援語音辨識。'));
    stopSpeaking();
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 5;
    current = rec;

    let got = false;
    rec.onresult = (e) => {
      got = true;
      const res = e.results[0];
      const alts = [];
      for (let i = 0; i < res.length; i++) alts.push(res[i].transcript);
      resolve(alts);
    };
    rec.onerror = (e) => {
      got = true;
      const msg =
        {
          'no-speech': '沒有聽到聲音，請靠近麥克風再唸一次。',
          'audio-capture': '找不到麥克風，請確認手機或電腦有麥克風。',
          'not-allowed': '麥克風權限被拒絕了，請到瀏覽器設定允許使用麥克風。',
          'service-not-allowed': '這個瀏覽器不允許語音辨識，請換 Chrome 或 Safari 試試。',
          network: '語音辨識需要網路連線，請確認網路後再試。',
          aborted: '已停止錄音。',
        }[e.error] || '辨識失敗，請再試一次。';
      reject(new Error(msg));
    };
    rec.onend = () => {
      current = null;
      if (!got) reject(new Error('沒有聽清楚，請再唸一次。'));
    };
    try {
      rec.start();
    } catch (err) {
      reject(new Error('無法開始錄音，請再按一次。'));
    }
  });
}

// 手動停止錄音（會觸發 onresult 或 onend）
export function stopListening() {
  if (current) {
    try {
      current.stop();
    } catch {}
  }
}

// 取消錄音（切換頁面時用）
export function abortListening() {
  if (current) {
    try {
      current.abort();
    } catch {}
    current = null;
  }
}
