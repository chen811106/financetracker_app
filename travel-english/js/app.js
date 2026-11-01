/* =========================================================
 * app.js — 畫面與流程
 *
 * 網址（hash）對應的畫面：
 *   #/                       首頁
 *   #/scene/ordering/listen  場景：聽
 *   #/scene/ordering/shadow  場景：跟讀
 *   #/scene/ordering/pattern 場景：句型卡
 *   #/scene/ordering/quiz    場景：聽懂對方
 * ========================================================= */

import * as store from './storage.js';
import * as speech from './speech.js';
import { bestOf, tokenize, feedback } from './score.js';

const app = document.getElementById('app');

// 四個分頁（學習順序）
const TABS = [
  { id: 'listen',  name: '聽',     icon: '🎧' },
  { id: 'shadow',  name: '跟讀',   icon: '🎤' },
  { id: 'pattern', name: '句型卡', icon: '🧩' },
  { id: 'quiz',    name: '聽懂對方', icon: '👂' },
];

/* ---------------- 小工具 ---------------- */

// 防止資料中的文字被當成 HTML
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isSlow = () => !!store.getSetting('slow');

// 播放一句（先停掉其他聲音）
function say(text, role) {
  speech.stopSpeaking();
  return speech.speak(text, { slow: isSlow(), role });
}

/* ---------------- 資料載入 ---------------- */

let scenesCache = null;
const sceneDataCache = {};

async function getScenes() {
  if (!scenesCache) {
    const res = await fetch('data/scenes.json');
    scenesCache = (await res.json()).scenes;
  }
  return scenesCache;
}

async function getSceneData(id) {
  if (!sceneDataCache[id]) {
    const scene = (await getScenes()).find((s) => s.id === id && s.available);
    if (!scene) throw new Error('找不到這個場景');
    const res = await fetch(scene.file);
    sceneDataCache[id] = await res.json();
  }
  return sceneDataCache[id];
}

/* ---------------- 路由 ---------------- */

async function router() {
  // 換頁時停止所有聲音與錄音
  speech.stopSpeaking();
  speech.abortListening();

  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'scene' && parts[1]) {
      const tab = TABS.some((t) => t.id === parts[2]) ? parts[2] : 'listen';
      await renderScene(parts[1], tab);
    } else {
      await renderHome();
    }
  } catch (err) {
    console.error(err);
    app.innerHTML = `
      <div class="page"><div class="notice warn">
        <p>載入失敗：${esc(err.message)}</p>
        <p>如果你是直接雙擊打開 index.html，請改用本機伺服器開啟（見 README）。</p>
        <a class="btn primary" href="#/">回首頁</a>
      </div></div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', router);

/* =========================================================
 * 首頁
 * ========================================================= */

async function renderHome() {
  const scenes = await getScenes();
  const today = store.getToday();
  const streak = store.getStreak();
  const goal = store.DAILY_GOAL;
  const pct = Math.min(100, Math.round((today.shadowed / goal) * 100));

  // 已開放的場景要先載入資料才能算完成度
  const percents = {};
  for (const s of scenes.filter((s) => s.available)) {
    try {
      percents[s.id] = store.getScenePercent(s.id, await getSceneData(s.id));
    } catch {
      percents[s.id] = 0;
    }
  }

  app.innerHTML = `
    <header class="hero">
      <h1>旅遊英文開口說</h1>
      <p>每天練一點，出國點餐不卡關！</p>
    </header>

    <main class="page">
      <section class="card today">
        <div class="today-head">
          <h2>今日進度</h2>
          ${streak > 0 ? `<span class="streak">🔥 連續 ${streak} 天</span>` : ''}
        </div>
        <div class="goal">
          <div class="goal-text">
            今天跟讀了 <b>${today.shadowed}</b> 句
            <span class="muted">／目標 ${goal} 句</span>
          </div>
          <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
          ${today.shadowed >= goal ? '<p class="goal-done">🎉 今天的目標完成了！</p>' : ''}
        </div>
        <ul class="stats">
          <li><span class="stat-num">${today.listened}</span><span>聽完對話</span></li>
          <li><span class="stat-num">${today.patterns}</span><span>練習句型</span></li>
          <li><span class="stat-num">${today.quiz}</span><span>聽懂題目</span></li>
        </ul>
      </section>

      <h2 class="section-title">選擇場景</h2>
      <div class="scene-grid">
        ${scenes.map((s) => s.available ? `
          <a class="scene-card" href="#/scene/${esc(s.id)}/listen">
            <span class="scene-emoji">${s.emoji}</span>
            <span class="scene-title">${esc(s.title)}</span>
            <span class="scene-desc">${esc(s.desc)}</span>
            <span class="mini-bar"><span style="width:${percents[s.id]}%"></span></span>
            <span class="scene-pct">完成 ${percents[s.id]}%</span>
          </a>` : `
          <div class="scene-card locked" aria-disabled="true">
            <span class="scene-emoji">${s.emoji}</span>
            <span class="scene-title">${esc(s.title)}</span>
            <span class="scene-desc">${esc(s.desc)}</span>
            <span class="soon">即將推出</span>
          </div>`).join('')}
      </div>

      ${supportNotice()}
    </main>`;
}

// 瀏覽器支援度提示（首頁與跟讀頁都會用到）
function supportNotice() {
  const msgs = [];
  if (!speech.ttsSupported) msgs.push('你的瀏覽器不支援語音播放，請改用手機的 Chrome 或 Safari。');
  if (!speech.sttSupported) msgs.push('你的瀏覽器不支援語音辨識，「跟讀」無法自動評分。建議使用 Android 的 Chrome 或 iPhone 的 Safari。');
  else if (!window.isSecureContext) msgs.push('目前不是安全連線（https），麥克風可能無法使用。');
  return msgs.length ? `<div class="notice warn">${msgs.map((m) => `<p>⚠️ ${m}</p>`).join('')}</div>` : '';
}

/* =========================================================
 * 場景頁（共用外框：上方標題列＋語速切換，下方分頁列）
 * ========================================================= */

async function renderScene(sceneId, tab) {
  const data = await getSceneData(sceneId);

  app.innerHTML = `
    <header class="topbar">
      <a class="back" href="#/" aria-label="回首頁">‹</a>
      <h1>${esc(data.title)}</h1>
      <div class="speed" role="group" aria-label="語速">
        <button data-slow="0" class="${isSlow() ? '' : 'on'}">正常</button>
        <button data-slow="1" class="${isSlow() ? 'on' : ''}">🐢 慢速</button>
      </div>
    </header>
    <main class="page with-tabs" id="tab-content"></main>
    <nav class="tabbar">
      ${TABS.map((t, i) => `
        <a href="#/scene/${esc(sceneId)}/${t.id}" class="${t.id === tab ? 'active' : ''}">
          <span class="tab-icon">${t.icon}</span>
          <span class="tab-name">${i + 1}. ${t.name}</span>
        </a>`).join('')}
    </nav>`;

  // 語速切換
  app.querySelectorAll('.speed button').forEach((b) =>
    b.addEventListener('click', () => {
      store.setSetting('slow', b.dataset.slow === '1');
      app.querySelectorAll('.speed button').forEach((x) => x.classList.toggle('on', x === b));
    })
  );

  const el = document.getElementById('tab-content');
  const views = { listen: viewListen, shadow: viewShadow, pattern: viewPattern, quiz: viewQuiz };
  views[tab](el, data);
}

// 頁面最下方的「下一步」按鈕
function nextStep(data, tabId) {
  const i = TABS.findIndex((t) => t.id === tabId);
  const next = TABS[i + 1];
  if (!next) return `<a class="btn ghost block" href="#/">✅ 完成！回首頁</a>`;
  return `<a class="btn ghost block" href="#/scene/${data.id}/${next.id}">下一步：${next.name} →</a>`;
}

/* =========================================================
 * 分頁 1：聽
 * ========================================================= */

function viewListen(el, data) {
  const showZh = store.getSetting('showZh') !== false;

  el.innerHTML = `
    <p class="tip">先聽整段對話。聽不懂的句子，點一下就能重聽。</p>
    <div class="row">
      <button class="btn primary big" id="play-all">▶ 播放整段</button>
      <label class="switch"><input type="checkbox" id="zh-toggle" ${showZh ? 'checked' : ''}> 顯示中文</label>
    </div>
    <ol class="dialogue ${showZh ? '' : 'hide-zh'}" id="dialogue">
      ${data.dialogue.map((line, i) => {
        const r = data.roles[line.role];
        return `
        <li class="bubble ${line.role}" data-i="${i}">
          <span class="who">${r.emoji} ${esc(r.name)}</span>
          <button class="say" aria-label="播放這句">
            <span class="en">${esc(line.en)}</span>
            <span class="zh">${esc(line.zh)}</span>
            <span class="spk">🔊</span>
          </button>
        </li>`;
      }).join('')}
    </ol>
    ${nextStep(data, 'listen')}`;

  const list = el.querySelector('#dialogue');
  const btn = el.querySelector('#play-all');
  let playing = false;

  const highlight = (i) => {
    list.querySelectorAll('.bubble').forEach((b) => b.classList.toggle('playing', Number(b.dataset.i) === i));
    const cur = list.querySelector(`.bubble[data-i="${i}"]`);
    cur?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const setPlaying = (v) => {
    playing = v;
    btn.textContent = v ? '■ 停止' : '▶ 播放整段';
    btn.classList.toggle('stop', v);
    if (!v) highlight(-1);
  };

  btn.addEventListener('click', async () => {
    if (playing) {
      speech.stopSpeaking();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    const completed = await speech.speakAll(data.dialogue, { slow: isSlow(), onLine: highlight });
    if (completed) store.markListened(data.id);
    // 如果是被別的動作中斷，就不要改按鈕（那個動作自己會處理）
    if (completed || playing) setPlaying(false);
  });

  // 點單句播放
  list.addEventListener('click', async (e) => {
    const li = e.target.closest('.bubble');
    if (!li) return;
    if (playing) setPlaying(false);
    const i = Number(li.dataset.i);
    highlight(i);
    await say(data.dialogue[i].en, data.dialogue[i].role);
    li.classList.remove('playing');
  });

  el.querySelector('#zh-toggle').addEventListener('change', (e) => {
    store.setSetting('showZh', e.target.checked);
    list.classList.toggle('hide-zh', !e.target.checked);
  });
}

/* =========================================================
 * 分頁 2：跟讀
 * ========================================================= */

const shadowIndex = {}; // 記住每個場景練到第幾句（同一次開啟中）

function viewShadow(el, data) {
  const lines = data.dialogue;
  let i = shadowIndex[data.id] || 0;
  let recording = false;

  function render(result) {
    shadowIndex[data.id] = i;
    const line = lines[i];
    const r = data.roles[line.role];
    const best = store.getSceneProgress(data.id).best;
    const words = result ? result.words : tokenize(line.en).map((w) => ({ display: w.display, ok: null }));

    el.innerHTML = `
      ${speech.sttSupported ? '' : supportNotice()}
      <p class="tip">① 按「聽示範」 ② 按「錄音」跟著唸 ③ 看哪些字唸對了</p>

      <div class="dots">
        ${lines.map((_, k) => `<button class="dot ${k === i ? 'cur' : ''} ${(best[k] || 0) >= 70 ? 'done' : ''}" data-k="${k}" aria-label="第 ${k + 1} 句"></button>`).join('')}
      </div>

      <section class="card shadow-card">
        <div class="shadow-head">
          <span class="count">第 ${i + 1} / ${lines.length} 句</span>
          <span class="who-tag ${line.role}">${r.emoji} ${esc(r.name)}</span>
        </div>
        <p class="sentence">
          ${words.map((w) => `<span class="w ${w.ok === null ? '' : w.ok ? 'ok' : 'bad'}">${esc(w.display)}</span>`).join(' ')}
        </p>
        <p class="sentence-zh">${esc(line.zh)}</p>
        ${best[i] != null ? `<p class="best">最高分：${best[i]} 分</p>` : ''}

        <div class="btn-col">
          <button class="btn secondary big" id="demo">🔊 聽示範</button>
          ${speech.sttSupported
            ? `<button class="btn primary big ${recording ? 'rec' : ''}" id="rec">${recording ? '⏹ 錄音中…按我停止' : result ? '🎤 再唸一次' : '🎤 錄音跟讀'}</button>`
            : `<button class="btn primary big" id="self">✔ 我已跟著唸完</button>`}
        </div>

        <div id="result">${result ? resultHtml(result) : ''}</div>
      </section>

      <div class="row nav">
        <button class="btn ghost" id="prev" ${i === 0 ? 'disabled' : ''}>← 上一句</button>
        <button class="btn ghost" id="next" ${i === lines.length - 1 ? 'disabled' : ''}>下一句 →</button>
      </div>
      ${i === lines.length - 1 ? nextStep(data, 'shadow') : ''}`;

    bind(result);
  }

  function resultHtml(res) {
    if (res.error) return `<div class="notice warn"><p>${esc(res.error)}</p></div>`;
    const fb = feedback(res.score);
    return `
      <div class="result ${fb.level}">
        <div class="score-circle"><b>${res.score}</b><small>分</small></div>
        <div>
          <p class="fb">${fb.text}</p>
          <p class="heard">你說的是：「${esc(res.spoken)}」</p>
        </div>
      </div>`;
  }

  function bind(result) {
    el.querySelector('#demo').addEventListener('click', () => say(lines[i].en, lines[i].role));
    // 換句時，先取消還在進行的錄音
    const go = (k) => {
      speech.abortListening();
      speech.stopSpeaking();
      recording = false;
      i = k;
      render();
    };
    el.querySelector('#prev').addEventListener('click', () => go(i - 1));
    el.querySelector('#next').addEventListener('click', () => go(i + 1));
    el.querySelectorAll('.dot').forEach((d) => d.addEventListener('click', () => go(Number(d.dataset.k))));

    // 不支援語音辨識時：自己按「唸完了」也算一次練習
    el.querySelector('#self')?.addEventListener('click', () => {
      store.markShadowed(data.id, i, 0);
      if (i < lines.length - 1) i++;
      render();
    });

    el.querySelector('#rec')?.addEventListener('click', async () => {
      if (recording) {
        speech.stopListening();
        return;
      }
      recording = true;
      render(result);
      const target = lines[i].en;
      const idx = i;
      try {
        const alts = await speech.listen();
        const res = bestOf(target, alts);
        store.markShadowed(data.id, idx, res.score);
        recording = false;
        if (idx === i) render(res);
      } catch (err) {
        recording = false;
        if (idx === i) render({ error: err.message, words: tokenize(target).map((w) => ({ display: w.display, ok: null })) });
      }
    });
  }

  render();
}

/* =========================================================
 * 分頁 3：句型卡
 * ========================================================= */

function viewPattern(el, data) {
  // 把句型中的 {} 換成指定內容
  const fill = (tpl, word, cls) => esc(tpl).replace('{}', `<span class="${cls}">${esc(word)}</span>`);
  const BLANK = '＿＿＿';

  el.innerHTML = `
    <p class="tip">點下面的單字，組成完整的句子，然後跟著唸出來！</p>
    ${data.patterns.map((p, pi) => `
      <section class="card pattern" data-p="${pi}">
        <h3 class="pattern-tpl">${fill(p.template, BLANK, 'blank')}</h3>
        <p class="pattern-zh">${fill(p.zh, BLANK, 'blank')}</p>
        <p class="pattern-tip">💡 ${esc(p.tip)}</p>
        <div class="chips">
          ${p.options.map((o, oi) => `
            <button class="chip" data-o="${oi}">
              <span>${esc(o.en)}</span><small>${esc(o.zh)}</small>
            </button>`).join('')}
        </div>
        <div class="built" hidden></div>
      </section>`).join('')}
    ${nextStep(data, 'pattern')}`;

  el.querySelectorAll('.pattern').forEach((card) => {
    const p = data.patterns[Number(card.dataset.p)];
    const built = card.querySelector('.built');

    card.querySelectorAll('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        const o = p.options[Number(chip.dataset.o)];
        card.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
        const sentence = p.template.replace('{}', o.en);
        built.hidden = false;
        built.innerHTML = `
          <button class="say-built">
            <span class="en">${fill(p.template, o.en, 'filled')}</span>
            <span class="zh">${fill(p.zh, o.zh, 'filled')}</span>
            <span class="spk">🔊 再聽一次</span>
          </button>`;
        built.querySelector('.say-built').addEventListener('click', () => say(sentence, 'customer'));
        say(sentence, 'customer');
        store.markPattern(data.id, p.id);
      })
    );
  });
}

/* =========================================================
 * 分頁 4：聽懂對方
 * ========================================================= */

function viewQuiz(el, data) {
  const qs = data.questions;
  let i = 0;
  let firstTryCorrect = 0;
  let wrongThisQ = false;

  function render() {
    if (i >= qs.length) return renderDone();
    const q = qs[i];
    // 選項打亂順序，但記住哪個是正確答案
    const choices = shuffle(q.choices.map((text, k) => ({ text, correct: k === q.answer })));
    wrongThisQ = false;

    el.innerHTML = `
      <p class="tip">聽聽看店員說什麼，選出正確的中文意思。</p>
      <section class="card quiz">
        <div class="shadow-head">
          <span class="count">第 ${i + 1} / ${qs.length} 題</span>
          <span class="who-tag staff">🧑‍🍳 店員說</span>
        </div>
        <button class="btn primary huge" id="play">🔊 播放</button>
        <button class="link" id="reveal">👀 看英文</button>
        <p class="quiz-en" id="quiz-en" hidden>${esc(q.en)}</p>

        <div class="choices">
          ${choices.map((c, k) => `<button class="choice" data-k="${k}">${esc(c.text)}</button>`).join('')}
        </div>
        <p class="quiz-msg" id="msg" aria-live="polite"></p>
        <div id="answer"></div>
      </section>`;

    const play = () => say(q.en, 'staff');
    el.querySelector('#play').addEventListener('click', play);
    el.querySelector('#reveal').addEventListener('click', (e) => {
      el.querySelector('#quiz-en').hidden = false;
      e.target.remove();
    });

    el.querySelectorAll('.choice').forEach((btn) =>
      btn.addEventListener('click', () => {
        const c = choices[Number(btn.dataset.k)];
        const msg = el.querySelector('#msg');
        if (!c.correct) {
          wrongThisQ = true;
          btn.classList.add('wrong');
          btn.disabled = true;
          msg.textContent = '不對喔，再聽一次！';
          msg.className = 'quiz-msg bad';
          play();
          return;
        }
        // 答對
        if (!wrongThisQ) firstTryCorrect++;
        store.markQuiz(data.id, i);
        btn.classList.add('right');
        el.querySelectorAll('.choice').forEach((b) => (b.disabled = true));
        el.querySelector('#quiz-en').hidden = false;
        el.querySelector('#reveal')?.remove();
        msg.textContent = '✅ 答對了！';
        msg.className = 'quiz-msg good';
        showReplies(q);
      })
    );
  }

  function showReplies(q) {
    const box = el.querySelector('#answer');
    box.innerHTML = `
      <div class="replies">
        <h4>你可以這樣回答：</h4>
        ${q.replies.map((r, k) => `
          <button class="reply" data-k="${k}">
            <span class="en">${esc(r.en)}</span>
            <span class="zh">${esc(r.zh)}</span>
            <span class="spk">🔊</span>
          </button>`).join('')}
      </div>
      <button class="btn primary big block" id="next">${i < qs.length - 1 ? '下一題 →' : '看結果'}</button>`;
    box.querySelectorAll('.reply').forEach((b) =>
      b.addEventListener('click', () => say(q.replies[Number(b.dataset.k)].en, 'customer'))
    );
    box.querySelector('#next').addEventListener('click', () => { i++; render(); window.scrollTo(0, 0); });
  }

  function renderDone() {
    el.innerHTML = `
      <section class="card done">
        <div class="done-emoji">🏆</div>
        <h2>全部完成！</h2>
        <p>一次就答對 <b>${firstTryCorrect}</b> / ${qs.length} 題</p>
        <button class="btn primary big block" id="again">再練一次</button>
      </section>
      ${nextStep(data, 'quiz')}`;
    el.querySelector('#again').addEventListener('click', () => { i = 0; firstTryCorrect = 0; render(); });
  }

  render();
}

/* ---------------- 啟動 ---------------- */

router();

// 註冊 Service Worker（離線使用）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 註冊失敗', e));
  });
}
