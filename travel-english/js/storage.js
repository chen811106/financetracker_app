/* =========================================================
 * storage.js — 學習進度與設定（存在 localStorage）
 *
 * 資料結構：
 * {
 *   settings: { slow: false, showZh: true },
 *   days: {                       // 每天的紀錄（只保留最近 60 天）
 *     "2026-11-01": {
 *       shadowed: ["ordering:3"],  // 今天跟讀過的句子（不重複計算）
 *       quiz:     ["ordering:0"],  // 今天答對的題目
 *       patterns: ["ordering:can-i-have"], // 今天練過的句型
 *       listened: ["ordering"]     // 今天聽完整段對話的場景
 *     }
 *   },
 *   scenes: {                     // 每個場景的累積成績
 *     ordering: { best: { "3": 85 }, quiz: { "0": true }, patterns: { "can-i-have": true }, listened: true }
 *   }
 * }
 * ========================================================= */

const KEY = 'travelEnglish.v1';
export const DAILY_GOAL = 5; // 每日跟讀目標（句）

// 讀取（任何錯誤都回傳空資料，讓 App 照常運作）
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const state = Object.assign({ settings: {}, days: {}, scenes: {} }, load());
state.settings = Object.assign({ slow: false, showZh: true }, state.settings);

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 私密模式或空間滿了：忽略，不影響使用 */
  }
}

// 本地時間的日期字串 YYYY-MM-DD
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 取得某天的紀錄（沒有就建立）
function day(key = dateKey()) {
  if (!state.days[key]) {
    state.days[key] = { shadowed: [], quiz: [], patterns: [], listened: [] };
    pruneOldDays();
  }
  return state.days[key];
}

// 只保留最近 60 天，避免資料越存越大
function pruneOldDays() {
  const keys = Object.keys(state.days).sort();
  while (keys.length > 60) delete state.days[keys.shift()];
}

function scene(id) {
  if (!state.scenes[id]) state.scenes[id] = { best: {}, quiz: {}, patterns: {}, listened: false };
  return state.scenes[id];
}

function addUnique(arr, v) {
  if (!arr.includes(v)) arr.push(v);
}

/* ---------- 設定 ---------- */
export function getSetting(name) {
  return state.settings[name];
}
export function setSetting(name, value) {
  state.settings[name] = value;
  save();
}

/* ---------- 記錄學習 ---------- */
export function markListened(sceneId) {
  addUnique(day().listened, sceneId);
  scene(sceneId).listened = true;
  save();
}

export function markShadowed(sceneId, index, score) {
  addUnique(day().shadowed, `${sceneId}:${index}`);
  const s = scene(sceneId);
  s.best[index] = Math.max(s.best[index] || 0, score);
  save();
}

export function markQuiz(sceneId, index) {
  addUnique(day().quiz, `${sceneId}:${index}`);
  scene(sceneId).quiz[index] = true;
  save();
}

export function markPattern(sceneId, patternId) {
  addUnique(day().patterns, `${sceneId}:${patternId}`);
  scene(sceneId).patterns[patternId] = true;
  save();
}

/* ---------- 查詢 ---------- */
export function getToday() {
  const d = state.days[dateKey()] || { shadowed: [], quiz: [], patterns: [], listened: [] };
  return {
    shadowed: d.shadowed.length,
    quiz: d.quiz.length,
    patterns: d.patterns.length,
    listened: d.listened.length,
  };
}

export function getSceneProgress(sceneId) {
  return scene(sceneId);
}

// 連續學習天數（今天還沒練的話，從昨天開始往回算）
export function getStreak() {
  const has = (k) => {
    const d = state.days[k];
    return d && (d.shadowed.length || d.quiz.length || d.patterns.length || d.listened.length);
  };
  const cur = new Date();
  if (!has(dateKey(cur))) cur.setDate(cur.getDate() - 1);
  let n = 0;
  while (has(dateKey(cur))) {
    n++;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}

// 場景完成度 0–100：聽完對話、跟讀 70 分以上、句型、題目 各自佔比
export function getScenePercent(sceneId, data) {
  const s = scene(sceneId);
  const total = 1 + data.dialogue.length + data.patterns.length + data.questions.length;
  let done = s.listened ? 1 : 0;
  done += Object.values(s.best).filter((v) => v >= 70).length;
  done += Object.keys(s.patterns).length;
  done += Object.keys(s.quiz).length;
  return Math.min(100, Math.round((done / total) * 100));
}
