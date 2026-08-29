/* =========================================================
   拾光記帳 · Healing Ledger — 前端互動邏輯（V1 原型）

   儲存策略：
   - 一律先寫入 localStorage（單機也能用，離線不中斷）。
   - 若執行環境提供 Claude Artifact 的 `artifact` capability
     （也就是以 Claude Artifact 網址開啟時），額外把整份頁面
     連同最新資料發布出去，達成跨裝置同步 —— 每個打開同一個
     Artifact 連結的裝置，看到的都會是最後一次發布的版本。
   - 在一般網頁（GitHub Pages）或本機檔案開啟時沒有這個
     capability，會自動略過雲端同步，僅維持單機 localStorage。
   ========================================================= */

(function () {
  "use strict";

  /* ---------------- 禁止手機雙指縮放 / 雙擊縮放 ----------------
     CSS 的 touch-action 跟 viewport meta 的 maximum-scale／user-scalable
     在部分瀏覽器（特別是 iOS Safari 10 之後）其實會被忽略，所以額外用
     JS 攔截手勢事件當作第二層保險：
     - gesturestart/gesturechange 是 Safari 專屬的雙指縮放手勢事件。
     - touchmove 一旦偵測到兩指以上，代表使用者正在 pinch，直接擋掉。
     - touchend 距離上一次 touchend 在 300ms 內，視為雙擊，也擋掉，
       避免快速點兩下把畫面放大。 */
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());
  document.addEventListener("touchmove", (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  /* ---------------- 支出分類設定 ----------------
     countsTowardPL：是否計入本月支出統計／圓餅圖（損益）。目前只有
     「調整」這種單純用來校正餘額、不是真正花費的分類預設為 false，
     其他都預設 true。使用者也可以在「管理分類」裡針對任何分類
     （不管內建還是自訂）另外覆寫這個設定，覆寫值存在
     state.categoryPLOverrides，優先權比這裡的預設值高。 */
  const CATEGORIES = [
    { key: "吃飯",        color: "var(--c-food)",    countsTowardPL: true,  keywords: ["早餐","午餐","晚餐","消夜","宵夜","咖啡","飲料","便當","餐廳","小吃","火鍋","燒烤","飯","麵","吃","茶","星巴克","超商","熱炒","早午餐","甜點","蛋糕","滷味","食材","買菜","生鮮","菜市場","果菜","蔬菜","水果","海鮮","豬肉","雞肉","牛肉","市場","肉","蛋","菜","優格","奇亞籽","食用油","橄欖油","沙拉油","苦茶油","麻油","堅果","牛奶","起司","豆腐","雞蛋"] },
    { key: "娛樂",        color: "var(--c-fun)",     countsTowardPL: true,  keywords: ["電影","KTV","唱歌","展覽","演唱會","旅遊","酒吧","門票","樂園","遊戲","娛樂","景點","飯店","住宿","機票"] },
    { key: "生活用品",     color: "var(--c-daily)",   countsTowardPL: true,  keywords: ["衛生紙","清潔","日用品","超市","全聯","家樂福","寶雅","洗髮精","牙膏","衛生棉","生活","雜貨","文具"] },
    { key: "油錢/停車費",  color: "var(--c-fuel)",    countsTowardPL: true,  keywords: ["加油","停車","油錢","停車費","高速公路","ETC","過路費","機車保養","汽車保養","洗車"] },
    { key: "交通",        color: "var(--c-transport)", countsTowardPL: true, keywords: ["捷運","公車","客運","火車","台鐵","高鐵","計程車","uber","Uber","悠遊卡","一卡通","電車","地鐵","轉乘","船票","公路局"] },
    { key: "會員費用",     color: "var(--c-member)",  countsTowardPL: true,  keywords: ["訂閱","會員","netflix","spotify","健身房","月費","年費","disney","youtube"] },
    { key: "服飾",        color: "var(--c-clothes)", countsTowardPL: true,  keywords: ["衣服","鞋子","包包","飾品","服飾","買衣","uniqlo","zara","gu","outlet","帽子","襪子"] },
    { key: "奢侈品",       color: "var(--c-luxury)",  countsTowardPL: true,  keywords: ["精品","名牌","珠寶","手錶","lv","gucci","chanel","奢侈","名錶","限量"] },
    { key: "投資",        color: "var(--c-invest)",  countsTowardPL: true,  keywords: ["買股","股票","定期定額","etf","基金","加碼","進場","證券","期貨","入手股","買進"] },
    { key: "調整",        color: "var(--c-adjust)",  countsTowardPL: false, keywords: ["調整","校正","更正","餘額調整","結餘調整","對帳","初始餘額","期初"] }
  ];
  // 這些是「內建」分類，程式碼更新時會調整；使用者也可以在「分類關鍵字」
  // 設定裡自行新增專屬關鍵字，或整個新增自己的分類（都存在 state 裡、
  // 會跟著同步），不用每次都改程式碼。allCategories() 把內建的跟使用者
  // 自訂的分類合併成一份清單，之後不管是自動分類、圖表、顏色顯示都從
  // 這份合併後的清單去找。
  const FALLBACK_CATEGORY = "生活用品";

  function allCategories() {
    return CATEGORIES.concat(state.customCategories || []);
  }

  function categorize(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    for (const cat of allCategories()) {
      const custom = (state.categoryKeywords && state.categoryKeywords[cat.key]) || [];
      if (cat.keywords.concat(custom).some(k => t.includes(k.toLowerCase()))) return cat.key;
    }
    return FALLBACK_CATEGORY;
  }

  /* ---------------- 收入分類設定 ---------------- */
  const INCOME_CATEGORIES = [
    { key: "薪資收入", color: "var(--c-salary)",    countsTowardPL: true,  keywords: ["薪水","薪資","月薪","工資","獎金","年終"] },
    { key: "生活費",   color: "var(--c-allowance)", countsTowardPL: true,  keywords: ["生活費","家用","零用錢","孝親費"] },
    { key: "股利收入", color: "var(--c-dividend)",  countsTowardPL: true,  keywords: ["股利","股息","配息","除權","除息"] },
    { key: "投資",     color: "var(--c-invest)",    countsTowardPL: true,  keywords: ["賣股","出場","賣出","股票","證券","期貨","獲利了結","出清"] },
    { key: "調整",     color: "var(--c-adjust)",    countsTowardPL: false, keywords: ["調整","校正","更正","餘額調整","結餘調整","對帳","初始餘額","期初"] },
    { key: "其他收入", color: "var(--c-other-income)", countsTowardPL: true, keywords: [] }
  ];
  const INCOME_FALLBACK_CATEGORY = "其他收入";

  function allIncomeCategories() {
    return INCOME_CATEGORIES.concat(state.customIncomeCategories || []);
  }

  function categorizeIncome(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    for (const cat of allIncomeCategories()) {
      const custom = (state.incomeCategoryKeywords && state.incomeCategoryKeywords[cat.key]) || [];
      if (cat.keywords.concat(custom).some(k => t.includes(k.toLowerCase()))) return cat.key;
    }
    return INCOME_FALLBACK_CATEGORY;
  }

  // 使用者自訂分類沒有固定的 CSS 色票可以用，新增時從這個小色盤依序輪流
  // 分配一個顏色（存起來，之後不會因為刪掉別的自訂分類而跟著變色）。
  const CUSTOM_CATEGORY_PALETTE = ["#8FA3A0","#B5A692","#9CA8B3","#C3A8A0","#A38C96","#BFA9CE","#CDB68A","#93A8A5"];

  function categoryColor(category, type) {
    const cat = (type === "income" ? allIncomeCategories() : allCategories()).find(c => c.key === category);
    if (cat) return cat.color;
    return type === "income" ? "var(--c-other-income)" : "var(--text-faint)";
  }

  // 「計入損益」＝這個分類算不算真正的支出/收入，會不會列入本月統計跟
  // 圓餅圖。支出跟收入各自有一個「調整」分類、剛好同名，所以覆寫值要
  // 用 type 一起當 key，不然改支出的「調整」會連收入的「調整」一起動到。
  function categoryPLKey(category, type) {
    return `${type}:${category}`;
  }
  function countsTowardPL(category, type) {
    const overrides = state.categoryPLOverrides || {};
    const compound = categoryPLKey(category, type);
    if (Object.prototype.hasOwnProperty.call(overrides, compound)) return overrides[compound];
    const cat = (type === "income" ? allIncomeCategories() : allCategories()).find(c => c.key === category);
    if (cat && typeof cat.countsTowardPL === "boolean") return cat.countsTowardPL;
    return true;
  }

  /* ---------------- 狀態 / 儲存 ---------------- */
  const STORAGE_KEY = "healing-ledger-v1";

  function currentMonthKey(d) {
    const now = d || new Date();
    return now.getFullYear() + "-" + (now.getMonth() + 1);
  }

  // 把 "YYYY-M" 或 "YYYY-MM"（<input type="month"> 存出來的格式）都轉成
  // 同一種可以互相比大小的數字，用來判斷「自動扣款到什麼時候」有沒有過期。
  function monthKeyToValue(key) {
    const [y, m] = String(key).split("-").map(Number);
    return y * 12 + m;
  }

  function seedState() {
    const now = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const thisMonth = (day) => iso(new Date(now.getFullYear(), now.getMonth(), day));
    const mKey = currentMonthKey(now);

    return {
      updatedAt: Date.now(),
      cashBalance: 1500,
      accounts: [
        { id: "a1", name: "國泰銀行", balance: 52340 },
        { id: "a2", name: "台北富邦", balance: 18000 },
        { id: "a3", name: "郵局帳戶", balance: 9000 }
      ],
      cards: [
        { id: "c1", name: "國泰 CUBE 卡", unbilled: 4200, billingDay: 20, dueDay: 5 },
        { id: "c2", name: "台新 Richart 卡", unbilled: 1500, billingDay: 15, dueDay: 3 }
      ],
      recurring: [
        { id: "r1", name: "房租", amount: 12000, done: false, resetDay: 1, lastResetMonth: mKey },
        { id: "r2", name: "電費", amount: 1200, done: false, resetDay: 10, lastResetMonth: mKey },
        { id: "r3", name: "網路費", amount: 799, done: true, resetDay: 5, lastResetMonth: mKey },
        { id: "r4", name: "健身房會員", amount: 1000, done: false, resetDay: 1, lastResetMonth: mKey }
      ],
      transactions: [
        { id: "t1", type: "expense", date: thisMonth(3),  item: "午餐便當",   amount: 120,  category: "吃飯",       paymentId: "cash" },
        { id: "t2", type: "expense", date: thisMonth(5),  item: "全聯日用品", amount: 640,  category: "生活用品",   paymentId: "a1" },
        { id: "t3", type: "expense", date: thisMonth(8),  item: "加油",       amount: 800,  category: "油錢/停車費", paymentId: "c1" },
        { id: "t4", type: "expense", date: thisMonth(10), item: "看電影",     amount: 320,  category: "娛樂",       paymentId: "c1" },
        { id: "t5", type: "expense", date: thisMonth(14), item: "Netflix 訂閱", amount: 390, category: "會員費用",  paymentId: "a2" },
        { id: "t6", type: "expense", date: thisMonth(18), item: "UNIQLO 買衣", amount: 1290, category: "服飾",      paymentId: "c2" },
        { id: "t7", type: "income",  date: thisMonth(5),  item: "薪資入帳",   amount: 45000, category: "薪資收入",  paymentId: "a1" }
      ]
    };
  }

  function readJson(str) {
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  // 從頁面內嵌的 <script id="app-state"> 讀出「目前這份文件」記錄的資料
  // （Claude Artifact 每次發布都會把最新資料連同整份頁面一起存起來，
  //  所以其他裝置打開同一個網址時，這個內嵌資料就是最新的雲端版本）
  function readEmbeddedState() {
    const el = document.getElementById("app-state");
    if (!el || !el.textContent.trim()) return null;
    return readJson(el.textContent);
  }

  function readLocalState() {
    return readJson(localStorage.getItem(STORAGE_KEY) || "");
  }

  // 本機與內嵌（雲端）兩份資料都存在時，用 updatedAt 挑比較新的那份
  function loadState() {
    const embedded = readEmbeddedState();
    const local = readLocalState();
    let chosen;
    if (embedded && local) {
      chosen = (local.updatedAt || 0) >= (embedded.updatedAt || 0) ? local : embedded;
    } else {
      chosen = embedded || local || seedState();
    }
    if (!chosen.updatedAt) chosen.updatedAt = Date.now();
    migrateState(chosen);
    return chosen;
  }

  // 舊資料相容：固定繳費項目補上各自的重置日；交易紀錄補上 type；
  // 每個分類補上使用者自訂關鍵字的儲存位置（只在缺少時建立空陣列，
  // 絕不覆蓋使用者已經新增過的自訂關鍵字）
  function migrateState(s) {
    const mKey = currentMonthKey();
    // 現金：原本只是記帳時的一個付款選項，沒有真正記錄餘額；現在跟銀行
    // 帳戶一樣有自己的餘額，可以在「帳戶」分頁查看／調整。舊資料沒有
    // 這個欄位的話，不能直接當成 0——有些人（包含在這之前就已經用「調整」
    // 分類手動記過一筆現金收入來代表目前現金餘額）過去記的現金相關紀錄
    // 其實是有意義的，所以用「重播」過去所有現金付款方式的支出/收入/
    // 信用卡繳款，算出遷移當下現金應該有多少，而不是讓數字憑空歸零。
    if (typeof s.cashBalance !== "number") {
      let cash = 0;
      (s.transactions || []).forEach(t => {
        if (t.paymentId !== "cash") return;
        if (t.type === "cardpayment") cash -= t.amount;
        else if ((t.type || "expense") === "income") cash += t.amount;
        else if ((t.type || "expense") === "expense") cash -= t.amount;
      });
      s.cashBalance = cash;
    }
    const legacyResetDay = s.recurringResetDay || 1;
    (s.recurring || []).forEach(r => {
      if (!r.resetDay) r.resetDay = legacyResetDay;
      // 沒有重置紀錄的舊資料：視為「這個月已經處理過」，避免一更新程式碼
      // 就把使用者已經勾選的項目重置掉
      if (!r.lastResetMonth) r.lastResetMonth = s.recurringLastResetMonth || mKey;
      // 自動扣款相關欄位：舊資料沒有的話一律視為「手動勾選」，不會突然
      // 幫使用者自動扣款。
      if (typeof r.autoDeduct !== "boolean") r.autoDeduct = false;
      if (r.autoPaymentId === undefined) r.autoPaymentId = null;
      if (r.autoUntil === undefined) r.autoUntil = null;
      if (r.lastTxId === undefined) r.lastTxId = null;
    });
    (s.transactions || []).forEach(t => {
      if (!t.type) t.type = "expense";
    });
    // 信用卡：把「本期應繳金額」（statementAmount，結帳日已鎖定、等
    // 繳款截止日要繳的錢）跟「已刷卡未出帳金額」（unbilled，結帳日之後
    // 新刷的、算在下一期帳單的錢）分開追蹤。舊資料只有一個 unbilled
    // 欄位，遷移時當成「本期應繳」處理（比較符合使用者原本輸入這個
    // 欄位時的認知），並把 lastBilledMonth 設成這個月，避免遷移完
    // 馬上又被下面的結帳邏輯誤判成「這個月還沒結帳」而重複合併一次。
    (s.cards || []).forEach(c => {
      if (c.statementAmount === undefined) {
        c.statementAmount = c.unbilled || 0;
        c.unbilled = 0;
      }
      if (!c.lastBilledMonth) c.lastBilledMonth = mKey;
    });
    // 使用者自己新增的分類（不是內建關鍵字，是整個新分類，例如「交通」
    // 以外自己想再加的類別），存在這兩個陣列裡，跟內建分類合併使用。
    if (!Array.isArray(s.customCategories)) s.customCategories = [];
    if (!Array.isArray(s.customIncomeCategories)) s.customIncomeCategories = [];
    // 舊的自訂分類（在「是否計入損益」這個功能出現之前新增的）預設當作
    // 一般分類，計入統計。
    s.customCategories.forEach(c => { if (typeof c.countsTowardPL !== "boolean") c.countsTowardPL = true; });
    s.customIncomeCategories.forEach(c => { if (typeof c.countsTowardPL !== "boolean") c.countsTowardPL = true; });
    // 使用者針對個別分類覆寫的「是否計入損益」設定（不管內建還是自訂
    // 分類都可以覆寫），key 是 "type:分類名稱"。
    if (!s.categoryPLOverrides || typeof s.categoryPLOverrides !== "object") s.categoryPLOverrides = {};

    if (!s.categoryKeywords) s.categoryKeywords = {};
    CATEGORIES.concat(s.customCategories).forEach(c => {
      if (!Array.isArray(s.categoryKeywords[c.key])) s.categoryKeywords[c.key] = [];
    });
    if (!s.incomeCategoryKeywords) s.incomeCategoryKeywords = {};
    INCOME_CATEGORIES.concat(s.customIncomeCategories).forEach(c => {
      if (!Array.isArray(s.incomeCategoryKeywords[c.key])) s.incomeCategoryKeywords[c.key] = [];
    });
  }

  function persistLocal(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* 儲存空間不足等情況靜默略過 */ }
  }

  function embedStateInDom(s) {
    let el = document.getElementById("app-state");
    if (!el) {
      el = document.createElement("script");
      el.type = "application/json";
      el.id = "app-state";
      document.body.insertBefore(el, document.body.firstChild);
    }
    el.textContent = JSON.stringify(s);
  }

  // Claude Artifact 的 `artifact` capability：可用時，儲存動作會把整份
  // 頁面連同最新資料一起發布，所有打開同一連結的裝置都會同步到這份。
  let cloudApi = null;

  async function initCloud() {
    if (typeof window.claude === "undefined" || typeof window.claude.use !== "function") {
      return;
    }
    try {
      cloudApi = await window.claude.use("artifact");
    } catch (e) {
      cloudApi = null;
    }
    updateSyncBadge();
  }

  function updateSyncBadge() {
    const badge = document.getElementById("syncBadge");
    if (!badge) return;
    if (cloudApi) {
      badge.textContent = "☁ 雲端同步中";
      badge.classList.add("on");
    } else {
      badge.textContent = "";
      badge.classList.remove("on");
    }
  }

  // 所有會改變資料的操作，最後都呼叫這個函式：
  // 1) 先寫本機 localStorage（永遠成功，離線也能用）
  // 2) 更新頁面內嵌的 app-state（讓「發布出去的這份文件」帶有最新資料）
  // 3) 若有雲端 capability，把整份文件發布出去，其他裝置打開同一連結
  //    就會看到最新資料。發布衝突是正常情況（例如兩台裝置差不多時間
  //    各自存了一筆），不重試 —— 之後 Claude 平台會把畫面同步回最終版本。
  async function saveState(s) {
    s.updatedAt = Date.now();
    persistLocal(s);
    embedStateInDom(s);
    if (!cloudApi) return;

    // document.documentElement.outerHTML 要把整份頁面（含所有交易紀錄）
    // 同步序列化成字串，資料越多這件事越不是瞬間完成——如果緊接著使用者
    // 剛做完的操作就同步做，畫面剛更新完的那一瞬間容易感覺頓一下。用
    // setTimeout 讓瀏覽器先把剛剛的畫面變化畫出來，序列化跟真正發布到
    // 雲端的動作延到下一個 tick 再做。
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 發布是非同步的，跟使用者接下來的操作（例如切換到下一個欄位打字）
    // 有可能重疊；平台同步完成、重新套用畫面時，正在輸入的欄位或原本
    // 停留的捲動位置可能被打斷、跳掉。記住發布前 focus 在哪個欄位、
    // 捲到哪裡，發布結束後主動拉回來，避免「畫面突然被拉走」的感覺。
    const activeId = document.activeElement && document.activeElement.id;
    const contentEl = document.querySelector(".content");
    const scrollTop = contentEl ? contentEl.scrollTop : 0;

    try {
      const html = "<!doctype html>\n" + document.documentElement.outerHTML;
      await cloudApi.publish(html);
    } catch (e) {
      /* 衝突或離線：不重試，交給平台把畫面同步回最新版本 */
    } finally {
      if (activeId) {
        const el = document.getElementById(activeId);
        if (el && document.activeElement !== el) el.focus({ preventScroll: true });
      }
      const contentElAfter = document.querySelector(".content");
      if (contentElAfter) contentElAfter.scrollTop = scrollTop;
    }
  }

  let state = loadState();
  persistLocal(state);

  /* ---------------- 共用工具 ----------------
     這幾個要放在 maybeResetRecurring／maybeCloseBillingCycle 前面：
     它們宣告下方緊接著就會被呼叫一次，而 uid() 現在被自動扣款那段
     邏輯用到，用 const 宣告的東西在自己那行執行之前都處在 TDZ、
     不能提前存取，所以要先宣告好才能呼叫那兩個函式。 */
  const fmt = new Intl.NumberFormat("zh-Hant-TW");
  const money = (n) => "$" + fmt.format(Math.round(n));
  const uid = () => Math.random().toString(36).slice(2, 9);

  /* ---------------- 每筆固定繳費各自的每月自動重置 ----------------
     只在載入當下判斷、只更動本機資料；真正發布給雲端的動作
     會等到使用者下一次實際操作（新增/刪除/勾選…）時才一併送出，
     符合「只在使用者互動後才發布」的原則。 */
  function maybeResetRecurring() {
    const now = new Date();
    const mKey = currentMonthKey(now);
    let changed = false;
    state.recurring.forEach(r => {
      if (r.lastResetMonth !== mKey && now.getDate() >= r.resetDay) {
        // 設定了「自動扣款」，而且還沒過「自動扣款到什麼時候」的話，
        // 就不用等使用者手動勾選，直接在這裡記一筆支出（跟手動勾選
        // 繳款走的是同一套帳戶/現金/信用卡連動邏輯）。
        const autoActive = r.autoDeduct && (!r.autoUntil || monthKeyToValue(mKey) <= monthKeyToValue(r.autoUntil));
        if (autoActive) {
          const paymentId = r.autoPaymentId || "cash";
          const tx = {
            id: uid(),
            type: "expense",
            date: new Date(now.getFullYear(), now.getMonth(), r.resetDay).toISOString().slice(0, 10),
            item: r.name,
            amount: r.amount,
            category: categorize(r.name),
            paymentId,
            recurringId: r.id
          };
          state.transactions.unshift(tx);
          applyPaymentDelta(paymentId, tx.amount, +1);
          r.done = true;
          r.lastTxId = tx.id;
        } else {
          r.done = false;
          // 上一期繳款留下的那筆交易紀錄本身不會動（是已經花掉的真實
          // 支出，要繼續留在帳本裡），只是解除跟這個待辦項目的關聯，
          // 這樣新的一期勾選繳款時才會另外開一筆新的紀錄，不會誤刪到
          // 上一期的。
          r.lastTxId = null;
        }
        r.lastResetMonth = mKey;
        changed = true;
      }
    });
    if (changed) persistLocal(state);
  }
  maybeResetRecurring();

  /* ---------------- 信用卡結帳日：把「已刷卡未出帳」併入「本期應繳」 ----------------
     每張卡結帳日一到，就把這段期間累積的 unbilled（已刷卡未出帳）併進
     statementAmount（本期應繳，繳款截止日前要繳的錢），unbilled 歸零、
     重新開始累積下一期的新刷卡金額。用「合併」而不是「取代」，所以就算
     上一期還沒繳完也不會不見，會繼續累加在 statementAmount 上——這樣
     不管有沒有準時繳款，金額永遠只會被記錄、合併，不會被自動清掉或刪除。
     同樣只在載入當下判斷、只更動本機資料，真正發布給雲端會等使用者
     下一次實際操作時才一併送出。 */
  function maybeCloseBillingCycle() {
    const now = new Date();
    const mKey = currentMonthKey(now);
    let changed = false;
    state.cards.forEach(c => {
      if (c.lastBilledMonth !== mKey && now.getDate() >= c.billingDay) {
        c.statementAmount = (c.statementAmount || 0) + (c.unbilled || 0);
        c.unbilled = 0;
        c.lastBilledMonth = mKey;
        changed = true;
      }
    });
    if (changed) persistLocal(state);
  }
  maybeCloseBillingCycle();

  function paymentLabel(id) {
    if (id === "cash") return "現金";
    const acc = state.accounts.find(a => a.id === id);
    if (acc) return acc.name;
    const card = state.cards.find(c => c.id === id);
    if (card) return card.name;
    return "未知帳戶";
  }

  // 收入不能存進信用卡，所以 excludeCards 會把信用卡選項拿掉
  function renderPaymentOptions(selectEl, opts) {
    const excludeCards = opts && opts.excludeCards;
    let html = `<option value="cash">現金</option>`;
    if (state.accounts.length) {
      html += `<optgroup label="銀行帳戶">`;
      html += state.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join("");
      html += `</optgroup>`;
    }
    if (!excludeCards && state.cards.length) {
      html += `<optgroup label="信用卡">`;
      html += state.cards.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
      html += `</optgroup>`;
    }
    const prevValue = selectEl.value;
    selectEl.innerHTML = html;
    if ([...selectEl.options].some(o => o.value === prevValue)) selectEl.value = prevValue;
  }

  /* ================= 首頁：快速記帳 ================= */
  const itemInput = document.getElementById("itemInput");
  const amountInput = document.getElementById("amountInput");
  const paymentSelect = document.getElementById("paymentSelect");
  const paymentLabelEl = document.getElementById("paymentLabel");
  const itemLabelEl = document.getElementById("itemLabel");
  const catDot = document.getElementById("catDot");
  const catLabel = document.getElementById("catLabel");
  const addBtn = document.getElementById("addBtn");
  const formHint = document.getElementById("formHint");
  const typeToggle = document.getElementById("typeToggle");

  let entryType = "expense"; // 'expense' | 'income'

  typeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".type-btn");
    if (!btn) return;
    entryType = btn.getAttribute("data-type");
    typeToggle.querySelectorAll(".type-btn").forEach(b => b.classList.toggle("active", b === btn));

    if (entryType === "income") {
      itemLabelEl.textContent = "收入項目";
      itemInput.placeholder = "例如：薪資入帳、股利、生活費";
      paymentLabelEl.textContent = "存入帳戶";
      addBtn.textContent = "新增收入";
    } else {
      itemLabelEl.textContent = "花費項目";
      itemInput.placeholder = "例如：星巴克拿鐵、加油、房租";
      paymentLabelEl.textContent = "支付方式";
      addBtn.textContent = "新增紀錄";
    }
    renderPaymentOptions(paymentSelect, { excludeCards: entryType === "income" });
    updateCategoryPreview();
  });

  function updateCategoryPreview() {
    const text = itemInput.value.trim();
    const guess = entryType === "income" ? categorizeIncome(text) : categorize(text);
    if (guess) {
      catDot.style.background = categoryColor(guess, entryType);
      catLabel.textContent = `自動分類為「${guess}」`;
      catLabel.style.color = "var(--text-primary)";
    } else {
      catDot.style.background = "var(--text-faint)";
      catLabel.textContent = "輸入後將自動判斷分類";
      catLabel.style.color = "var(--text-secondary)";
    }
  }

  itemInput.addEventListener("input", updateCategoryPreview);

  addBtn.addEventListener("click", () => {
    const item = itemInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const paymentId = paymentSelect.value;

    if (!item) { showHint(entryType === "income" ? "請輸入收入項目" : "請輸入花費項目"); return; }
    if (!amount || amount <= 0) { showHint("請輸入有效金額"); return; }

    const category = entryType === "income" ? categorizeIncome(item) : categorize(item);

    const tx = {
      id: uid(),
      type: entryType,
      date: new Date().toISOString().slice(0, 10),
      item, amount, category, paymentId
    };
    state.transactions.unshift(tx);
    // 支出：sign +1（帳戶減少／卡片未出帳增加）。收入：sign -1，剛好是同一個
    // 函式反過來的效果（帳戶增加），現金則兩種情況都不影響任何帳戶。
    applyPaymentDelta(paymentId, amount, entryType === "expense" ? +1 : -1);

    itemInput.value = "";
    amountInput.value = "";
    catDot.style.background = "var(--text-faint)";
    catLabel.textContent = "輸入後將自動判斷分類";
    showHint(`已記錄「${item}」，歸類於${category} ✓`);
    // 新增完主動收起鍵盤：不然如果原本是從「金額」欄位按下鍵盤上的
    // 送出鍵觸發，欄位清空後 focus 還留在原地、鍵盤沒關，之後畫面
    // 重新排版（例如鍵盤自己決定要不要收起來）時機不固定，會有種
    // 「畫面自己跳走」的感覺。這裡直接、確定地收起鍵盤。
    itemInput.blur();
    amountInput.blur();

    renderHome();
    renderChart();
    renderAccounts();
    renderCards();

    saveState(state);
  });

  function showHint(msg) {
    formHint.textContent = msg;
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => (formHint.textContent = ""), 2600);
  }

  function applyPaymentDelta(paymentId, amount, sign) {
    // sign +1 = 支出效果（帳戶／現金減少、卡片未出帳增加）；sign -1 =
    // 收入效果（帳戶／現金增加）或刪除一筆支出時的還原。
    if (paymentId === "cash") { state.cashBalance -= amount * sign; return; }
    const acc = state.accounts.find(a => a.id === paymentId);
    if (acc) { acc.balance -= amount * sign; return; }
    const card = state.cards.find(c => c.id === paymentId);
    if (card) { card.unbilled += amount * sign; }
  }

  // sign +1 = 執行轉帳（from 帳戶減少、to 帳戶增加）；sign -1 = 刪除轉帳紀錄時還原
  function applyTransfer(fromId, toId, amount, sign) {
    const fromAcc = state.accounts.find(a => a.id === fromId);
    const toAcc = state.accounts.find(a => a.id === toId);
    if (fromAcc) fromAcc.balance -= amount * sign;
    if (toAcc) toAcc.balance += amount * sign;
  }

  // 信用卡繳款：sign +1 = 執行繳款（付款帳戶／現金減少、該卡本期應繳金額
  // statementAmount 減少）；sign -1 = 刪除這筆繳款紀錄時還原。只還
  // 「本期應繳」，不動已刷卡未出帳（unbilled）的部分。
  function payCardBill(cardId, paymentId, amount, sign) {
    const card = state.cards.find(c => c.id === cardId);
    if (card) card.statementAmount -= amount * sign;
    if (paymentId === "cash") { state.cashBalance -= amount * sign; return; }
    const acc = state.accounts.find(a => a.id === paymentId);
    if (acc) acc.balance -= amount * sign;
  }

  function deleteTransaction(id) {
    const idx = state.transactions.findIndex(t => t.id === id);
    if (idx === -1) return;
    const tx = state.transactions[idx];
    if (tx.type === "transfer") {
      applyTransfer(tx.fromAccountId, tx.toAccountId, tx.amount, -1);
    } else if (tx.type === "cardpayment") {
      payCardBill(tx.cardId, tx.paymentId, tx.amount, -1);
    } else {
      applyPaymentDelta(tx.paymentId, tx.amount, tx.type === "income" ? +1 : -1);
    }
    // 如果這筆是從「週期性繳費清單」勾選繳款自動記下來的，刪掉它也要
    // 把那個待辦項目取消勾選，不然會變成錢已經還回來了、清單上卻還
    // 顯示「已繳」的不一致狀態。
    if (tx.recurringId) {
      const rec = state.recurring.find(r => r.id === tx.recurringId);
      if (rec) { rec.done = false; rec.lastTxId = null; }
      renderRecurring();
    }
    state.transactions.splice(idx, 1);
    renderHome(); renderChart(); renderAccounts(); renderCards();
    saveState(state);
  }

  // 所有刪除動作的防呆確認視窗：傳入要顯示的說明文字，以及按下「刪除」
  // 後真正執行的動作。取消或點背景都不會刪除任何東西。
  function confirmDelete(message, onConfirm) {
    modalBody.innerHTML = `
      <h3>確定要刪除嗎？</h3>
      <p class="confirm-message">${message}</p>
      <div class="modal-actions">
        <button class="btn-cancel" id="confirmCancelBtn">取消</button>
        <button class="btn-danger" id="confirmDeleteBtn">刪除</button>
      </div>`;
    modalOverlay.classList.add("open");
    modalBody.querySelector("#confirmCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#confirmDeleteBtn").addEventListener("click", () => {
      closeModal();
      onConfirm();
    });
  }

  function monthTransactions(offset, type) {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const y = target.getFullYear(), m = target.getMonth();
    return state.transactions.filter(t => {
      const txType = t.type || "expense";
      if (type && txType !== type) return false;
      // 「調整」這類只是拿來校正帳戶/現金餘額用的分類（例如手動輸入
      // 初始餘額、對帳誤差），不是真正的花費或收入，所以本月支出/收入
      // 統計跟圓餅圖都不列入——但金額還是會照樣影響帳戶餘額，也還是會
      // 留在最近紀錄裡。哪些分類算/不算，看 countsTowardPL()（使用者可
      // 以在「管理分類」裡自己調整，不是只有「調整」這個分類能設定）。
      if (!countsTowardPL(t.category, txType)) return false;
      const d = new Date(t.date);
      return d.getFullYear() === y && d.getMonth() === m;
    });
  }
  const monthTotalSpend = (offset = 0) => monthTransactions(offset, "expense");
  const monthTotalIncome = (offset = 0) => monthTransactions(offset, "income");

  function renderHome() {
    const spendTotal = monthTotalSpend(0).reduce((s, t) => s + t.amount, 0);
    document.getElementById("monthTotal").textContent = money(spendTotal);

    const incomeTotal = monthTotalIncome(0).reduce((s, t) => s + t.amount, 0);
    document.getElementById("monthIncome").textContent = money(incomeTotal);

    const accTotal = state.accounts.reduce((s, a) => s + a.balance, 0) + state.cashBalance;
    document.getElementById("totalBalance").textContent = money(accTotal);

    renderPaymentOptions(paymentSelect, { excludeCards: entryType === "income" });

    const list = document.getElementById("recentList");
    const empty = document.getElementById("recentEmpty");
    const recent = state.transactions.slice(0, 8);
    empty.style.display = recent.length ? "none" : "block";
    list.innerHTML = recent.map(t => {
      if (t.type === "transfer") {
        return `
          <li class="list-item">
            <span class="item-dot" style="background:var(--c-adjust)"></span>
            <div class="item-main">
              <div class="item-title">${escapeHtml(t.item)}</div>
              <div class="item-sub">${t.date} · 從 ${paymentLabel(t.fromAccountId)} 轉到 ${paymentLabel(t.toAccountId)}</div>
            </div>
            <div class="item-amount">⇄ ${money(t.amount)}</div>
            <button class="item-delete" data-del="${t.id}" aria-label="刪除">✕</button>
          </li>`;
      }
      if (t.type === "cardpayment") {
        const card = state.cards.find(c => c.id === t.cardId);
        const cardName = card ? card.name : "未知信用卡";
        return `
          <li class="list-item">
            <span class="item-dot" style="background:var(--c-adjust)"></span>
            <div class="item-main">
              <div class="item-title">${escapeHtml(cardName)} 繳款</div>
              <div class="item-sub">${t.date} · 用 ${paymentLabel(t.paymentId)} 支付</div>
            </div>
            <div class="item-amount">💳 ${money(t.amount)}</div>
            <button class="item-delete" data-del="${t.id}" aria-label="刪除">✕</button>
          </li>`;
      }
      const color = categoryColor(t.category, t.type);
      const isIncome = t.type === "income";
      return `
        <li class="list-item">
          <span class="item-dot" style="background:${color}"></span>
          <div class="item-main">
            <div class="item-title">${escapeHtml(t.item)}</div>
            <div class="item-sub">${t.date} · ${t.category} · ${paymentLabel(t.paymentId)}</div>
          </div>
          <div class="item-amount${isIncome ? " income" : ""}">${isIncome ? "+" : "-"}${money(t.amount)}</div>
          <button class="item-delete" data-del="${t.id}" aria-label="刪除">✕</button>
        </li>`;
    }).join("");

    list.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del");
        const tx = state.transactions.find(t => t.id === id);
        if (!tx) return;
        const desc = tx.type === "transfer"
          ? `「${escapeHtml(tx.item)}」⇄ ${money(tx.amount)} 這筆轉帳紀錄刪除後無法復原，兩個帳戶的餘額會各自還原。`
          : tx.type === "cardpayment"
          ? `這筆信用卡繳款紀錄（💳 ${money(tx.amount)}）刪除後無法復原，支付帳戶的餘額跟信用卡的本期應繳金額都會還原。`
          : `「${escapeHtml(tx.item)}」${tx.type === "income" ? "+" : "-"}${money(tx.amount)} 這筆紀錄刪除後無法復原。`;
        confirmDelete(desc, () => deleteTransaction(id));
      });
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  /* ================= 圖表（支出／收入各一個圓餅圖，共用同一個月份） ================= */
  let chartMonthOffset = 0;

  document.getElementById("prevMonth").addEventListener("click", () => { chartMonthOffset--; renderChart(); });
  document.getElementById("nextMonth").addEventListener("click", () => {
    if (chartMonthOffset < 0) chartMonthOffset++;
    renderChart();
  });

  // 共用的甜甜圈圖繪製邏輯：傳入要更新的 DOM id 跟資料，支出／收入圖表都靠它畫
  function renderDonutChart({ svgId, totalId, legendId, emptyId, entries, type }) {
    const svg = document.getElementById(svgId);
    const legend = document.getElementById(legendId);
    const emptyEl = document.getElementById(emptyId);
    const total = entries.reduce((s, e) => s + e.value, 0);
    document.getElementById(totalId).textContent = money(total);

    if (!total) {
      svg.innerHTML = `<circle cx="100" cy="100" r="80" fill="none" stroke="#E2D9CC" stroke-width="26"/>`;
      legend.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    const r = 80, cx = 100, cy = 100, circumference = 2 * Math.PI * r;
    let offset = 0;
    const rootStyles = getComputedStyle(document.documentElement);
    const resolveColor = (c) => c.startsWith("var(") ? rootStyles.getPropertyValue(c.slice(4, -1)).trim() : c;

    const sorted = entries.filter(e => e.value > 0).sort((a, b) => b.value - a.value);

    svg.innerHTML = sorted.map(e => {
      const frac = e.value / total;
      const len = frac * circumference;
      const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${resolveColor(e.color)}" stroke-width="26"
        stroke-dasharray="${len} ${circumference - len}"
        stroke-dashoffset="${-offset}" />`;
      offset += len;
      return circle;
    }).join("");

    // 每一列都可以點進去看這個分類這個月的明細（哪一天花在什麼上面），
    // 用 data-cat/data-type 記住是圖表哪一格被點的，交給
    // openCategoryDetailModal 依照目前月份份重新查一次交易。
    legend.innerHTML = sorted.map(e => `
      <li class="legend-clickable" data-cat="${escapeAttr(e.key)}" data-type="${type}">
        <span class="item-dot" style="background:${e.color}"></span>
        <span class="legend-name">${e.key}</span>
        <span class="legend-percent">${Math.round((e.value / total) * 100)}%</span>
        <span class="legend-amount">${money(e.value)}</span>
        <span class="legend-arrow">›</span>
      </li>`).join("");

    legend.querySelectorAll("[data-cat]").forEach(li => {
      li.addEventListener("click", () => {
        openCategoryDetailModal(li.getAttribute("data-cat"), li.getAttribute("data-type"));
      });
    });
  }

  // 點圓餅圖圖例某一格分類，彈出這個月（圖表目前翻到的那個月）這個
  // 分類底下所有紀錄的明細，例如點「吃飯」就能看到 8/23 吃了什麼、
  // 8/24 又吃了什麼，純瀏覽用，不能在這裡編輯或刪除。
  function openCategoryDetailModal(key, type) {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + chartMonthOffset, 1);
    const monthLabel = `${target.getFullYear()} 年 ${target.getMonth() + 1} 月`;

    const txs = (type === "income" ? monthTotalIncome(chartMonthOffset) : monthTotalSpend(chartMonthOffset))
      .filter(t => t.category === key)
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const total = txs.reduce((s, t) => s + t.amount, 0);
    const isIncome = type === "income";

    const rows = txs.map(t => `
      <li class="list-item">
        <div class="item-main">
          <div class="item-title">${escapeHtml(t.item)}</div>
          <div class="item-sub">${t.date} · ${paymentLabel(t.paymentId)}</div>
        </div>
        <div class="item-amount${isIncome ? " income" : ""}">${isIncome ? "+" : "-"}${money(t.amount)}</div>
      </li>`).join("");

    modalBody.innerHTML = `
      <h3>${monthLabel} · ${escapeHtml(key)}</h3>
      <p class="hint-text" style="margin:0 0 8px;">共 ${txs.length} 筆，合計 ${money(total)}</p>
      <ul class="plain-list modal-scroll-list">${rows || `<li class="empty-hint" style="display:block;">這個月「${escapeHtml(key)}」還沒有紀錄</li>`}</ul>
      <div class="modal-actions">
        <button class="btn-save" id="catDetailCloseBtn" style="flex:1;">關閉</button>
      </div>`;
    modalOverlay.classList.add("open");
    modalBody.querySelector("#catDetailCloseBtn").addEventListener("click", closeModal);
  }

  function categoryTotals(transactions) {
    const totals = {};
    transactions.forEach(t => { totals[t.category] = (totals[t.category] || 0) + t.amount; });
    return totals;
  }

  function renderChart() {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + chartMonthOffset, 1);
    document.getElementById("chartMonthLabel").textContent =
      `${target.getFullYear()} 年 ${target.getMonth() + 1} 月`;

    const expenseTotals = categoryTotals(monthTotalSpend(chartMonthOffset));
    renderDonutChart({
      svgId: "donutChart", totalId: "donutTotal", legendId: "chartLegend", emptyId: "chartEmpty", type: "expense",
      entries: allCategories().map(c => ({ key: c.key, color: c.color, value: expenseTotals[c.key] || 0 }))
    });

    const incomeTotals = categoryTotals(monthTotalIncome(chartMonthOffset));
    renderDonutChart({
      svgId: "donutChartIncome", totalId: "donutTotalIncome", legendId: "chartLegendIncome", emptyId: "chartEmptyIncome", type: "income",
      entries: allIncomeCategories().map(c => ({ key: c.key, color: c.color, value: incomeTotals[c.key] || 0 }))
    });
  }

  /* ================= 帳戶 ================= */
  function renderAccounts() {
    const list = document.getElementById("accountList");
    // 現金固定釘在最上面，且不能刪除（不是「新增」出來的帳戶，是內建
    // 的一個付款方式，只是現在多了可以查看／調整的餘額）；只給編輯按鈕。
    const cashRow = `
      <li class="list-item">
        <span class="item-dot" style="background:var(--c-fuel)"></span>
        <div class="item-main">
          <div class="item-title">現金</div>
          <div class="item-sub">隨身現金</div>
        </div>
        <div class="item-amount">${money(state.cashBalance)}</div>
        <button class="item-edit" id="editCashBtn" aria-label="編輯">✎</button>
      </li>`;

    list.innerHTML = cashRow + state.accounts.map(a => `
      <li class="list-item">
        <span class="item-dot" style="background:var(--c-fun)"></span>
        <div class="item-main">
          <div class="item-title">${escapeHtml(a.name)}</div>
          <div class="item-sub">銀行帳戶</div>
        </div>
        <div class="item-amount">${money(a.balance)}</div>
        <button class="item-delete" data-del-acc="${a.id}" aria-label="刪除">✕</button>
      </li>`).join("");

    document.getElementById("editCashBtn").addEventListener("click", openCashModal);

    list.querySelectorAll("[data-del-acc]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-acc");
        const acc = state.accounts.find(a => a.id === id);
        if (!acc) return;
        confirmDelete(`帳戶「${escapeHtml(acc.name)}」（餘額 ${money(acc.balance)}）刪除後無法復原，過去用這個帳戶記的紀錄不會被刪除，但會顯示為未知帳戶。`, () => {
          state.accounts = state.accounts.filter(a => a.id !== id);
          renderAccounts(); renderHome();
          saveState(state);
        });
      });
    });

    document.getElementById("accountsTotal").textContent =
      money(state.accounts.reduce((s, a) => s + a.balance, 0) + state.cashBalance);
  }

  // 現金餘額用一個很單純的單欄位 modal 直接調整（例如提款、發現數字對
  // 不上想手動校正），不透過記一筆支出/收入，避免又跑出一筆不必要的
  // 交易紀錄——跟信用卡編輯視窗一樣，是「設定目前的值」而不是「加減」。
  function openCashModal() {
    openModal({
      title: "調整現金餘額",
      fields: [
        { key: "cashBalance", label: "目前現金餘額", type: "number", placeholder: "0" }
      ],
      initial: { cashBalance: state.cashBalance },
      onSave: (v) => {
        state.cashBalance = parseFloat(v.cashBalance) || 0;
        renderAccounts(); renderHome();
      }
    });
  }

  document.getElementById("addAccountBtn").addEventListener("click", () => {
    openModal({
      title: "新增銀行帳戶",
      fields: [
        { key: "name", label: "帳戶名稱", type: "text", placeholder: "例如：中國信託" },
        { key: "balance", label: "目前餘額", type: "number", placeholder: "0" }
      ],
      onSave: (v) => {
        if (!v.name) return;
        state.accounts.push({ id: uid(), name: v.name, balance: parseFloat(v.balance) || 0 });
        renderAccounts(); renderHome();
      }
    });
  });

  /* ================= 帳戶互轉 =================
     只在自己的銀行帳戶之間搬錢，不算支出也不算收入，所以不會影響
     本月支出/收入統計或圓餅圖；有紀錄在「最近紀錄」裡方便回頭查。 */
  document.getElementById("transferBtn").addEventListener("click", openTransferModal);

  function openTransferModal() {
    if (state.accounts.length < 2) {
      modalBody.innerHTML = `
        <h3>帳戶互轉</h3>
        <p class="confirm-message">要先有兩個以上的銀行帳戶才能互轉，先去新增一個帳戶吧。</p>
        <div class="modal-actions">
          <button class="btn-save" id="transferOkBtn" style="flex:1;">好</button>
        </div>`;
      modalOverlay.classList.add("open");
      modalBody.querySelector("#transferOkBtn").addEventListener("click", closeModal);
      return;
    }

    const accountOptions = state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
    modalBody.innerHTML = `
      <h3>帳戶互轉</h3>
      <label class="field-label">從</label>
      <select id="transferFrom" class="text-input">${accountOptions}</select>
      <label class="field-label">轉到</label>
      <select id="transferTo" class="text-input">${accountOptions}</select>
      <label class="field-label">金額</label>
      <input id="transferAmount" class="text-input" type="number" min="0" placeholder="0">
      <label class="field-label">備註（選填）</label>
      <input id="transferNote" class="text-input" placeholder="例如：生活費撥款">
      <p class="hint-text" id="transferHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="transferCancelBtn">取消</button>
        <button class="btn-save" id="transferSaveBtn">轉帳</button>
      </div>`;
    modalOverlay.classList.add("open");

    const fromSel = modalBody.querySelector("#transferFrom");
    const toSel = modalBody.querySelector("#transferTo");
    toSel.selectedIndex = 1; // 預設「到」跟「從」不是同一個帳戶

    modalBody.querySelector("#transferCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#transferSaveBtn").addEventListener("click", () => {
      const fromId = fromSel.value;
      const toId = toSel.value;
      const amount = parseFloat(modalBody.querySelector("#transferAmount").value);
      const hint = modalBody.querySelector("#transferHint");

      if (fromId === toId) { hint.textContent = "「從」跟「轉到」不能是同一個帳戶"; return; }
      if (!amount || amount <= 0) { hint.textContent = "請輸入有效金額"; return; }

      const fromAcc = state.accounts.find(a => a.id === fromId);
      const toAcc = state.accounts.find(a => a.id === toId);
      const note = modalBody.querySelector("#transferNote").value.trim();

      state.transactions.unshift({
        id: uid(),
        type: "transfer",
        date: new Date().toISOString().slice(0, 10),
        item: note || `${fromAcc.name} → ${toAcc.name}`,
        amount,
        fromAccountId: fromId,
        toAccountId: toId
      });
      applyTransfer(fromId, toId, amount, +1);

      closeModal();
      renderAccounts(); renderHome();
      saveState(state);
    });
  }

  /* ================= 匯出記帳紀錄（純文字）／清理記帳項目 =================
     把支出/收入/信用卡繳款紀錄依月份整理成一段純文字（逐筆明細 + 月
     支出/收入分佈百分比，百分比的分類範圍跟算法都跟「圖表」頁一致，
     一樣只算計入損益的分類；信用卡繳款本身不是一個分類，不會列入
     百分比計算，但一樣會出現在逐筆明細裡），最後加上一段「目前帳戶
     總覽」的即時快照，給使用者自己複製貼到別的地方保存。
     「清理記帳項目」會把支出/收入/信用卡繳款這三種紀錄都清空——轉帳
     不算日常花費，繼續保留。帳戶/信用卡/現金餘額本來就是各自獨立
     累計的數字，不是即時從交易紀錄加總出來的，所以清掉這些舊紀錄
     完全不影響這些餘額、也不影響待辦清單跟分類設定。 */
  function categoryDistributionLine(txs) {
    if (!txs.length) return "";
    const totals = categoryTotals(txs);
    const total = txs.reduce((s, t) => s + t.amount, 0);
    return Object.keys(totals)
      .map(k => ({ key: k, value: totals[k] }))
      .sort((a, b) => b.value - a.value)
      .map(e => `${e.key}${Math.round((e.value / total) * 100)}%`)
      .join("、");
  }

  // 逐筆明細每一行的格式：日期 [分類：]項目：±金額元：付款方式。
  // 信用卡繳款沒有分類，中括號那段就省略；付款方式一律用
  // paymentLabel()，跟「最近紀錄」列表顯示的名稱一致。
  function formatExportLine(t) {
    const d = new Date(t.date);
    const sign = t.type === "income" ? "+" : "-";
    const categoryPart = t.category ? `${t.category}：` : "";
    return `${d.getMonth() + 1}/${d.getDate()} ${categoryPart}${t.item}：${sign}${fmt.format(Math.round(t.amount))}元：${paymentLabel(t.paymentId)}`;
  }

  function buildExportText() {
    // 依「年-月」把支出/收入/信用卡繳款紀錄分組；轉帳不算日常加減，
    // 不放進匯出的文字裡。
    const groups = {};
    state.transactions.forEach(t => {
      const type = t.type || "expense";
      if (type !== "expense" && type !== "income" && type !== "cardpayment") return;
      const d = new Date(t.date);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      if (!groups[key]) groups[key] = { y: d.getFullYear(), m: d.getMonth() + 1, txs: [] };
      groups[key].txs.push(t);
    });

    const monthKeys = Object.keys(groups).sort((a, b) => {
      const ga = groups[a], gb = groups[b];
      return ga.y - gb.y || ga.m - gb.m;
    });

    const lines = [];
    monthKeys.forEach(key => {
      const g = groups[key];
      const txs = g.txs.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      lines.push(`「${g.y}/${g.m}記帳明細」`);
      txs.forEach(t => lines.push(formatExportLine(t)));
      lines.push("");

      // 支出/收入分佈的百分比只看真正的支出/收入分類（信用卡繳款不是
      // 分類，不列入），算法、篩選跟「圖表」頁完全一致。
      const expenseTxs = txs.filter(t => (t.type || "expense") === "expense" && countsTowardPL(t.category, "expense"));
      lines.push(`「${g.m}月支出分佈」`);
      lines.push(categoryDistributionLine(expenseTxs) || "（本月無計入統計的支出）");
      lines.push("");

      const incomeTxs = txs.filter(t => t.type === "income" && countsTowardPL(t.category, "income"));
      lines.push(`「${g.m}月收入分佈」`);
      lines.push(categoryDistributionLine(incomeTxs) || "（本月無計入統計的收入）");
      lines.push("");
    });

    // 最後加一段「現在帳戶總覽」的即時快照，跟上面逐月的歷史明細不同，
    // 這段永遠是「匯出當下」的最新餘額，方便對照這份紀錄結算到哪裡。
    lines.push("「截至目前帳戶總覽」");
    const total = state.accounts.reduce((s, a) => s + a.balance, 0) + state.cashBalance;
    lines.push(`總餘額：${fmt.format(Math.round(total))}元`);
    const breakdown = [{ name: "現金", balance: state.cashBalance }]
      .concat(state.accounts.map(a => ({ name: a.name, balance: a.balance })))
      .map(a => `${a.name}：${fmt.format(Math.round(a.balance))}元`)
      .join("、");
    lines.push(breakdown);

    return lines.join("\n").trim() + "\n";
  }

  document.getElementById("exportBtn").addEventListener("click", openExportModal);

  function openExportModal() {
    const text = buildExportText();
    const hasHistory = state.transactions.some(t => {
      const type = t.type || "expense";
      return type === "expense" || type === "income" || type === "cardpayment";
    });

    modalBody.innerHTML = `
      <h3>匯出記帳紀錄</h3>
      <p class="hint-text" style="margin:0 0 8px;">依月份整理成文字，複製起來就能貼到別的地方自己保存，最後一段是目前帳戶餘額的即時快照。</p>
      <textarea id="exportTextArea" class="text-input export-textarea" rows="10" readonly>${escapeHtml(text)}</textarea>
      <p class="hint-text" id="exportHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="exportCloseBtn">關閉</button>
        <button class="btn-save" id="exportCopyBtn">📋 複製文字</button>
      </div>
      ${hasHistory ? `<button class="add-mini secondary" id="exportClearBtn" style="width:100%;margin-top:14px;">🗑 清理記帳項目（保留帳戶/卡片/待辦/分類設定）</button>` : ""}`;
    modalOverlay.classList.add("open");

    modalBody.querySelector("#exportCloseBtn").addEventListener("click", closeModal);

    const hint = modalBody.querySelector("#exportHint");
    modalBody.querySelector("#exportCopyBtn").addEventListener("click", async () => {
      const ta = modalBody.querySelector("#exportTextArea");
      ta.select();
      try {
        await navigator.clipboard.writeText(text);
        hint.textContent = "已複製到剪貼簿 ✓";
      } catch (e) {
        hint.textContent = "自動複製失敗，文字已幫你全選好，用 Ctrl/Cmd+C 手動複製吧";
      }
    });

    if (hasHistory) {
      modalBody.querySelector("#exportClearBtn").addEventListener("click", () => {
        confirmDelete(
          "確定要清理記帳項目嗎？這會把上面列出的所有支出/收入/信用卡繳款紀錄清空（轉帳紀錄會保留）——帳戶、信用卡、現金餘額、待辦清單、分類設定都不會被動到。請先確認上面的文字已經複製保存好，這個動作無法復原。",
          () => {
            state.transactions = state.transactions.filter(t => {
              const type = t.type || "expense";
              return type !== "expense" && type !== "income" && type !== "cardpayment";
            });
            // 待辦清單裡如果有項目正指著一筆剛好被清掉的交易，順便把
            // 「已繳」狀態解除，避免變成「顯示已繳、卻找不到那筆紀錄」
            // 的不一致狀態。
            state.recurring.forEach(r => {
              if (r.lastTxId && !state.transactions.some(t => t.id === r.lastTxId)) {
                r.lastTxId = null;
                r.done = false;
              }
            });
            renderHome(); renderChart(); renderAccounts(); renderCards(); renderRecurring();
            saveState(state);
          }
        );
      });
    }
  }

  /* ================= 信用卡 ================= */
  const CARD_THEMES = ["", "theme-1", "theme-2", "theme-3"];

  function nextDueInfo(card) {
    const now = new Date();
    let due = new Date(now.getFullYear(), now.getMonth(), card.dueDay);
    if (due < now) due = new Date(now.getFullYear(), now.getMonth() + 1, card.dueDay);
    const daysLeft = Math.ceil((due - now) / 86400000);
    let cls = "";
    if (daysLeft <= 3) cls = "urgent";
    else if (daysLeft <= 7) cls = "warn";
    return { due, daysLeft, cls };
  }

  function renderCards() {
    const list = document.getElementById("cardList");
    const empty = document.getElementById("cardsEmpty");
    empty.style.display = state.cards.length ? "none" : "block";

    list.innerHTML = state.cards.map((c, i) => {
      const statementAmount = c.statementAmount || 0;
      const unbilled = c.unbilled || 0;
      // 到期badge只在「本期應繳」大於 0 時才顯示，避免明明沒有待繳金額
      // 卻還被一個逾期警示嚇到。
      const dueBlock = statementAmount > 0 ? (() => {
        const { daysLeft, cls } = nextDueInfo(c);
        const badgeText = daysLeft <= 0 ? "已逾期" : `${daysLeft} 天後到期`;
        return `<span class="due-badge ${cls}"><span class="due-dot"></span>${badgeText}</span>`;
      })() : `<span class="due-badge">目前無待繳</span>`;
      const limit = c.limit || 0;
      const totalOwed = statementAmount + unbilled; // 額度看的是這張卡總共欠多少，不分本期/下期
      const limitBlock = limit > 0 ? `
          <div class="credit-card-limit">
            <div class="limit-bar"><div class="limit-fill${totalOwed / limit >= 0.8 ? " high" : ""}" style="width:${Math.min(100, Math.max(0, (totalOwed / limit) * 100))}%"></div></div>
            <div class="limit-text">可用額度 ${money(Math.max(0, limit - totalOwed))} ／ 額度 ${money(limit)}</div>
          </div>` : "";
      const unbilledNote = unbilled > 0
        ? `<div class="credit-card-unbilled-note">已刷卡未出帳 ${money(unbilled)}（下期帳單，${c.billingDay} 號結帳後才會列入應繳）</div>`
        : "";
      return `
        <li class="credit-card ${CARD_THEMES[i % CARD_THEMES.length]}">
          <div class="credit-card-top">
            <span class="credit-card-name">${escapeHtml(c.name)}</span>
            <div class="credit-card-actions">
              <button class="credit-card-edit" data-edit-card="${c.id}" aria-label="編輯">✎</button>
              <button class="credit-card-delete" data-del-card="${c.id}" aria-label="刪除">✕</button>
            </div>
          </div>
          <div class="credit-card-amount">
            <small>本期應繳金額</small>
            ${money(statementAmount)}
          </div>${unbilledNote}${limitBlock}
          <div class="credit-card-bottom">
            <span>每月 ${c.billingDay} 號結帳 · ${c.dueDay} 號前繳款</span>
            ${dueBlock}
          </div>
          ${statementAmount > 0 ? `<button class="credit-card-pay-btn" data-pay-card="${c.id}">✓ 已繳款</button>` : ""}
        </li>`;
    }).join("");

    list.querySelectorAll("[data-pay-card]").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = state.cards.find(c => c.id === btn.getAttribute("data-pay-card"));
        if (card) openCardPaymentModal(card);
      });
    });
    list.querySelectorAll("[data-del-card]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-card");
        const card = state.cards.find(c => c.id === id);
        if (!card) return;
        const owed = (card.statementAmount || 0) + (card.unbilled || 0);
        confirmDelete(`信用卡「${escapeHtml(card.name)}」（目前欠款 ${money(owed)}）刪除後無法復原。`, () => {
          state.cards = state.cards.filter(c => c.id !== id);
          renderCards(); renderHome();
          saveState(state);
        });
      });
    });
    list.querySelectorAll("[data-edit-card]").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = state.cards.find(c => c.id === btn.getAttribute("data-edit-card"));
        if (card) openCardModal(card);
      });
    });
  }

  function openCardModal(existing) {
    openModal({
      title: existing ? "編輯信用卡" : "新增信用卡",
      fields: [
        { key: "name", label: "卡片名稱", type: "text", placeholder: "例如：玉山 Only 卡" },
        { key: "statementAmount", label: "本期應繳金額（繳款截止日前要繳的錢）", type: "number", placeholder: "0" },
        { key: "unbilled", label: "已刷卡未出帳金額（下期才要繳，選填）", type: "number", placeholder: "0" },
        { key: "limit", label: "信用卡額度（選填，用來算可用額度）", type: "number", placeholder: "0 表示不設定" },
        { key: "billingDay", label: "結帳日（每月幾號）", type: "number", placeholder: "20" },
        { key: "dueDay", label: "繳款截止日（每月幾號）", type: "number", placeholder: "5" }
      ],
      initial: existing ? {
        name: existing.name, statementAmount: existing.statementAmount, unbilled: existing.unbilled,
        limit: existing.limit || "", billingDay: existing.billingDay, dueDay: existing.dueDay
      } : null,
      onSave: (v) => {
        if (!v.name) return;
        const data = {
          name: v.name,
          statementAmount: parseFloat(v.statementAmount) || 0,
          unbilled: parseFloat(v.unbilled) || 0,
          limit: parseFloat(v.limit) || 0,
          billingDay: Math.min(28, Math.max(1, parseInt(v.billingDay) || 20)),
          dueDay: Math.min(28, Math.max(1, parseInt(v.dueDay) || 5))
        };
        if (existing) {
          Object.assign(existing, data);
        } else {
          // 新卡的 lastBilledMonth 設成這個月：避免剛輸入好「本期應繳」跟
          // 「已刷卡未出帳」兩個分開的金額，一存檔就被結帳邏輯誤判成
          // 「這個月的結帳日還沒處理過」而立刻合併在一起。
          state.cards.push({ id: uid(), lastBilledMonth: currentMonthKey(), ...data });
        }
        renderCards(); renderHome();
      }
    });
  }

  /* ================= 信用卡繳款 =================
     記一筆「繳款」：從某個帳戶（或現金）付錢，把這張卡「本期應繳金額」
     （statementAmount）沖掉一部分或全部——只還本期已經出帳、快到期的
     錢，不會動到「已刷卡未出帳」（unbilled，屬於下一期帳單）的部分。
     這筆錢在買東西當下（applyPaymentDelta 把 unbilled 加上去的時候）
     就已經算過一次支出了，所以繳款本身不算新的支出，也不算收入 ——
     跟帳戶互轉一樣，只是單純的資金移動紀錄。 */
  function openCardPaymentModal(card) {
    if (card.statementAmount <= 0) {
      modalBody.innerHTML = `
        <h3>信用卡繳款</h3>
        <p class="confirm-message">「${escapeHtml(card.name)}」目前沒有應繳金額，不需要繳款。</p>
        <div class="modal-actions">
          <button class="btn-save" id="cardPayOkBtn" style="flex:1;">好</button>
        </div>`;
      modalOverlay.classList.add("open");
      modalBody.querySelector("#cardPayOkBtn").addEventListener("click", closeModal);
      return;
    }

    let amountMode = "full"; // 'full' | 'custom'
    const methodOptions = `<option value="cash">現金</option>` +
      state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");

    modalBody.innerHTML = `
      <h3>信用卡繳款 · ${escapeHtml(card.name)}</h3>
      <p class="hint-text" style="margin:0 0 4px;">本期應繳金額 ${money(card.statementAmount)}</p>
      <label class="field-label">繳款金額</label>
      <div class="type-toggle" id="cardPayAmountToggle">
        <button type="button" class="type-btn active" data-mode="full">全部</button>
        <button type="button" class="type-btn" data-mode="custom">自訂金額</button>
      </div>
      <input id="cardPayAmount" class="text-input" type="number" min="0" max="${card.statementAmount}" value="${card.statementAmount}" readonly style="margin-top:8px;">
      <label class="field-label">用什麼方式繳款</label>
      <select id="cardPayMethod" class="text-input">${methodOptions}</select>
      <p class="hint-text" id="cardPayHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="cardPayCancelBtn">取消</button>
        <button class="btn-save" id="cardPaySaveBtn">確認繳款</button>
      </div>`;
    modalOverlay.classList.add("open");

    const amountToggle = modalBody.querySelector("#cardPayAmountToggle");
    const amountInput = modalBody.querySelector("#cardPayAmount");
    const hint = modalBody.querySelector("#cardPayHint");

    amountToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".type-btn");
      if (!btn) return;
      amountMode = btn.getAttribute("data-mode");
      amountToggle.querySelectorAll(".type-btn").forEach(b => b.classList.toggle("active", b === btn));
      if (amountMode === "full") {
        amountInput.value = card.statementAmount;
        amountInput.readOnly = true;
      } else {
        amountInput.readOnly = false;
        amountInput.value = "";
        amountInput.focus();
      }
    });

    modalBody.querySelector("#cardPayCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#cardPaySaveBtn").addEventListener("click", () => {
      const amount = parseFloat(amountInput.value);
      const paymentId = modalBody.querySelector("#cardPayMethod").value;
      if (!amount || amount <= 0) { hint.textContent = "請輸入有效金額"; return; }
      if (amount > card.statementAmount) { hint.textContent = `金額不能超過本期應繳金額 ${money(card.statementAmount)}`; return; }

      state.transactions.unshift({
        id: uid(),
        type: "cardpayment",
        date: new Date().toISOString().slice(0, 10),
        item: `${card.name} 繳款`,
        amount,
        cardId: card.id,
        paymentId
      });
      payCardBill(card.id, paymentId, amount, +1);

      closeModal();
      renderCards(); renderAccounts(); renderHome();
      saveState(state);
    });
  }

  document.getElementById("addCardBtn").addEventListener("click", () => openCardModal(null));

  /* ================= 週期性繳費（每筆各自設定重置日） ================= */
  function renderRecurring() {
    const list = document.getElementById("recurringList");
    const empty = document.getElementById("recurringEmpty");
    empty.style.display = state.recurring.length ? "none" : "block";

    list.innerHTML = state.recurring.map(r => {
      const autoNote = r.autoDeduct
        ? `<div class="recurring-sub recurring-auto">🔁 每月 ${r.resetDay} 號自動用「${escapeHtml(paymentLabel(r.autoPaymentId))}」扣款${r.autoUntil ? `，扣到 ${escapeHtml(r.autoUntil)} 為止` : ""}</div>`
        : `<div class="recurring-sub">每月 ${r.resetDay} 號重置為未繳納</div>`;
      return `
      <li class="recurring-item">
        <button class="checkbox ${r.done ? "checked" : ""}" data-toggle="${r.id}" aria-label="標記完成">${r.done ? "✓" : ""}</button>
        <div class="recurring-main">
          <div class="recurring-name ${r.done ? "done" : ""}">${escapeHtml(r.name)}</div>
          ${autoNote}
        </div>
        <div class="recurring-amount ${r.done ? "done" : ""}">${money(r.amount)}</div>
        <div class="recurring-actions">
          <button class="item-edit" data-edit-rec="${r.id}" aria-label="編輯">✎</button>
          <button class="item-delete" data-del-rec="${r.id}" aria-label="刪除">✕</button>
        </div>
      </li>`;
    }).join("");

    list.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = state.recurring.find(x => x.id === btn.getAttribute("data-toggle"));
        if (!r) return;
        if (r.done) {
          // 取消勾選：把剛剛那筆繳款紀錄一併刪掉，付款帳戶/現金/信用卡
          // 未出帳金額都跟著還原，避免「打勾取消了、錢卻還是扣著」。
          if (r.lastTxId) {
            const idx = state.transactions.findIndex(t => t.id === r.lastTxId);
            if (idx !== -1) {
              const tx = state.transactions[idx];
              applyPaymentDelta(tx.paymentId, tx.amount, -1);
              state.transactions.splice(idx, 1);
            }
            r.lastTxId = null;
          }
          r.done = false;
          renderRecurring(); renderHome(); renderChart(); renderAccounts(); renderCards();
          saveState(state);
        } else {
          openRecurringPayModal(r);
        }
      });
    });
    list.querySelectorAll("[data-del-rec]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-rec");
        const r = state.recurring.find(x => x.id === id);
        if (!r) return;
        confirmDelete(`固定繳費項目「${escapeHtml(r.name)}」（${money(r.amount)}）刪除後無法復原。`, () => {
          state.recurring = state.recurring.filter(x => x.id !== id);
          renderRecurring();
          saveState(state);
        });
      });
    });
    list.querySelectorAll("[data-edit-rec]").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = state.recurring.find(x => x.id === btn.getAttribute("data-edit-rec"));
        if (r) openRecurringModal(r);
      });
    });
  }

  /* ================= 固定繳費：勾選繳款 =================
     點下待辦項目的勾選框時，先問「用什麼方式繳的」，選好之後才真的
     記一筆支出（帳戶/現金/信用卡未出帳跟著連動），並記住這筆交易的
     id（lastTxId），這樣取消勾選、或之後在「最近紀錄」直接刪掉這筆
     交易時，待辦清單才能同步把勾選狀態還原、不會兜不起來。 */
  function openRecurringPayModal(r) {
    const methodOptions = `<option value="cash">現金</option>` +
      (state.accounts.length ? `<optgroup label="銀行帳戶">` + state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("") + `</optgroup>` : "") +
      (state.cards.length ? `<optgroup label="信用卡">` + state.cards.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("") + `</optgroup>` : "");

    modalBody.innerHTML = `
      <h3>${escapeHtml(r.name)} 已繳款</h3>
      <label class="field-label">金額</label>
      <input id="recPayAmount" class="text-input" type="number" min="0" value="${r.amount}">
      <label class="field-label">用什麼方式繳的</label>
      <select id="recPayMethod" class="text-input">${methodOptions}</select>
      <p class="hint-text" id="recPayHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="recPayCancelBtn">取消</button>
        <button class="btn-save" id="recPaySaveBtn">確認</button>
      </div>`;
    modalOverlay.classList.add("open");

    modalBody.querySelector("#recPayCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#recPaySaveBtn").addEventListener("click", () => {
      const amount = parseFloat(modalBody.querySelector("#recPayAmount").value);
      const paymentId = modalBody.querySelector("#recPayMethod").value;
      const hint = modalBody.querySelector("#recPayHint");
      if (!amount || amount <= 0) { hint.textContent = "請輸入有效金額"; return; }

      const tx = {
        id: uid(),
        type: "expense",
        date: new Date().toISOString().slice(0, 10),
        item: r.name,
        amount,
        category: categorize(r.name),
        paymentId,
        recurringId: r.id
      };
      state.transactions.unshift(tx);
      applyPaymentDelta(paymentId, amount, +1);

      r.done = true;
      r.lastTxId = tx.id;

      closeModal();
      renderRecurring(); renderHome(); renderChart(); renderAccounts(); renderCards();
      saveState(state);
    });
  }

  // 固定繳費項目要在「手動勾選」跟「自動扣款」之間切換、自動扣款還要
  // 再多選「用什麼方式扣」跟「扣到什麼時候」，欄位會動態顯示/隱藏，
  // 超出通用 openModal() 能處理的範圍，所以這裡跟信用卡繳款一樣自己刻
  // modal 內容。
  function openRecurringModal(existing) {
    let autoDeduct = existing ? !!existing.autoDeduct : false;
    const methodOptions = () => `<option value="cash">現金</option>` +
      (state.accounts.length ? `<optgroup label="銀行帳戶">` + state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("") + `</optgroup>` : "") +
      (state.cards.length ? `<optgroup label="信用卡">` + state.cards.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("") + `</optgroup>` : "");

    modalBody.innerHTML = `
      <h3>${existing ? "編輯固定繳費項目" : "新增固定繳費項目"}</h3>
      <label class="field-label">項目名稱</label>
      <input id="recName" class="text-input" placeholder="例如：房租、水電費" value="${existing ? escapeAttr(existing.name) : ""}">
      <div class="row">
        <div class="field">
          <label class="field-label">金額</label>
          <input id="recAmount" class="text-input" type="number" min="0" placeholder="0" value="${existing ? existing.amount : ""}">
        </div>
        <div class="field">
          <label class="field-label">每月幾號</label>
          <input id="recResetDay" class="text-input" type="number" min="1" max="28" placeholder="1" value="${existing ? existing.resetDay : ""}">
        </div>
      </div>
      <label class="field-label">繳費方式</label>
      <div class="type-toggle" id="recAutoToggle">
        <button type="button" class="type-btn ${!autoDeduct ? "active" : ""}" data-auto="0">手動勾選繳款</button>
        <button type="button" class="type-btn ${autoDeduct ? "active" : ""}" data-auto="1">自動扣款</button>
      </div>
      <div id="recAutoFields" ${autoDeduct ? "" : 'style="display:none;"'}>
        <label class="field-label">用什麼方式自動扣款</label>
        <select id="recAutoMethod" class="text-input">${methodOptions()}</select>
        <label class="field-label">自動扣款到什麼時候（留空表示一直自動扣下去）</label>
        <input id="recAutoUntil" class="text-input" type="month" value="${existing && existing.autoUntil ? existing.autoUntil : ""}">
        <p class="hint-text" style="margin-top:2px;">到期後這個項目不會被刪除，只是改回「每月自己勾選繳款」。</p>
      </div>
      <p class="hint-text" id="recHint"></p>
      <div class="modal-actions">
        <button class="btn-cancel" id="recCancelBtn">取消</button>
        <button class="btn-save" id="recSaveBtn">儲存</button>
      </div>`;
    modalOverlay.classList.add("open");

    if (existing && existing.autoPaymentId) {
      modalBody.querySelector("#recAutoMethod").value = existing.autoPaymentId;
    }

    modalBody.querySelector("#recAutoToggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".type-btn");
      if (!btn) return;
      autoDeduct = btn.getAttribute("data-auto") === "1";
      modalBody.querySelector("#recAutoToggle").querySelectorAll(".type-btn").forEach(b => b.classList.toggle("active", b === btn));
      modalBody.querySelector("#recAutoFields").style.display = autoDeduct ? "" : "none";
    });

    modalBody.querySelector("#recCancelBtn").addEventListener("click", closeModal);
    modalBody.querySelector("#recSaveBtn").addEventListener("click", () => {
      const name = modalBody.querySelector("#recName").value.trim();
      const amount = parseFloat(modalBody.querySelector("#recAmount").value);
      const resetDay = Math.min(28, Math.max(1, parseInt(modalBody.querySelector("#recResetDay").value) || 1));
      const hint = modalBody.querySelector("#recHint");
      if (!name) { hint.textContent = "請輸入項目名稱"; return; }
      if (!amount || amount <= 0) { hint.textContent = "請輸入有效金額"; return; }

      const autoPaymentId = autoDeduct ? modalBody.querySelector("#recAutoMethod").value : null;
      const autoUntil = autoDeduct ? (modalBody.querySelector("#recAutoUntil").value || null) : null;

      if (existing) {
        existing.name = name;
        existing.amount = amount;
        existing.resetDay = resetDay;
        existing.autoDeduct = autoDeduct;
        existing.autoPaymentId = autoPaymentId;
        existing.autoUntil = autoUntil;
      } else {
        state.recurring.push({
          id: uid(),
          name, amount,
          done: false,
          resetDay,
          lastResetMonth: currentMonthKey(),
          autoDeduct, autoPaymentId, autoUntil,
          lastTxId: null
        });
      }
      closeModal();
      renderRecurring();
      saveState(state);
    });
  }

  document.getElementById("addRecurringBtn").addEventListener("click", () => openRecurringModal(null));

  /* ================= 通用 Modal =================
     儲存動作統一放在「關閉 Modal 之後」才執行，確保發布出去的
     文件快照裡，Modal 已經是關閉狀態（不會下次打開就看到彈窗）。 */
  const modalOverlay = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");

  function openModal({ title, fields, onSave, initial }) {
    modalBody.innerHTML = `
      <h3>${title}</h3>
      ${fields.map(f => `
        <label class="field-label">${f.label}</label>
        <input class="text-input" type="${f.type}" placeholder="${f.placeholder || ""}" data-field="${f.key}" value="${initial && initial[f.key] !== undefined ? escapeAttr(String(initial[f.key])) : ""}">
      `).join("")}
      <div class="modal-actions">
        <button class="btn-cancel" id="modalCancel">取消</button>
        <button class="btn-save" id="modalSave">儲存</button>
      </div>`;
    modalOverlay.classList.add("open");

    modalBody.querySelector("#modalCancel").addEventListener("click", closeModal);
    modalBody.querySelector("#modalSave").addEventListener("click", () => {
      const values = {};
      fields.forEach(f => {
        values[f.key] = modalBody.querySelector(`[data-field="${f.key}"]`).value.trim();
      });
      onSave(values);
      closeModal();
      saveState(state);
    });
  }

  function escapeAttr(s) {
    return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function closeModal() {
    modalOverlay.classList.remove("open");
    modalBody.innerHTML = "";
  }

  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  /* ================= 分類關鍵字管理 =================
     系統預設關鍵字（CATEGORIES / INCOME_CATEGORIES 裡寫死的）只顯示、
     不能刪；使用者可以另外新增自己的關鍵字，存在 state 裡、會跟著
     雲端同步，之後遇到判斷不準的情況自己就能修正，不用再等改程式碼。 */
  document.getElementById("manageCategoriesBtn").addEventListener("click", openCategoryManager);

  function openCategoryManager() {
    let kwType = "expense";
    let newCategoryColor = CUSTOM_CATEGORY_PALETTE[0];

    modalBody.innerHTML = `
      <h3>管理分類</h3>
      <div class="type-toggle" id="kwType">
        <button type="button" class="type-btn active" data-type="expense">支出分類</button>
        <button type="button" class="type-btn" data-type="income">收入分類</button>
      </div>
      <label class="field-label">選擇分類</label>
      <select id="kwCategorySelect" class="text-input"></select>
      <div id="kwCategorySettings"></div>
      <div class="field-label" style="margin-top:14px;">系統預設關鍵字</div>
      <div class="chip-list" id="kwDefaultChips"></div>
      <div class="field-label" style="margin-top:14px;">我新增的關鍵字</div>
      <div class="chip-list" id="kwCustomChips"></div>
      <div class="row" style="margin-top:10px;">
        <input id="kwNewInput" class="text-input" placeholder="輸入新關鍵字，例如：青菜">
        <button class="add-mini" id="kwAddBtn" style="white-space:nowrap;">新增</button>
      </div>
      <div class="field-label" style="margin-top:18px;">新增一個屬於自己的分類</div>
      <div class="row">
        <input id="kwNewCategoryInput" class="text-input" placeholder="例如：交通、寵物">
        <button class="add-mini" id="kwAddCategoryBtn" style="white-space:nowrap;">新增分類</button>
      </div>
      <label class="field-label">分類顏色</label>
      <div class="color-picker-row">
        <div class="swatch-list" id="kwSwatchList"></div>
        <input type="color" id="kwColorPicker" class="color-well" value="${newCategoryColor}" title="用滑動式調色盤自訂顏色">
        <input type="text" id="kwColorHex" class="text-input color-hex-input" placeholder="#RRGGBB" maxlength="7" value="${newCategoryColor}">
      </div>
      <label class="checkbox-label">
        <input type="checkbox" id="kwNewCategoryPL" checked>
        <span>計入本月支出/收入統計（損益）</span>
      </label>
      <p class="hint-text" id="kwNewCategoryHint"></p>
      <div class="modal-actions">
        <button class="btn-save" id="kwDone" style="flex:1;">完成</button>
      </div>`;
    modalOverlay.classList.add("open");

    const kwTypeToggle = modalBody.querySelector("#kwType");
    const categorySelect = modalBody.querySelector("#kwCategorySelect");
    const settingsEl = modalBody.querySelector("#kwCategorySettings");
    const defaultChipsEl = modalBody.querySelector("#kwDefaultChips");
    const customChipsEl = modalBody.querySelector("#kwCustomChips");
    const newInput = modalBody.querySelector("#kwNewInput");
    const newCategoryInput = modalBody.querySelector("#kwNewCategoryInput");
    const newCategoryHint = modalBody.querySelector("#kwNewCategoryHint");
    const swatchListEl = modalBody.querySelector("#kwSwatchList");
    const colorPicker = modalBody.querySelector("#kwColorPicker");
    const colorHex = modalBody.querySelector("#kwColorHex");
    const newCategoryPLCheckbox = modalBody.querySelector("#kwNewCategoryPL");

    function categoryList() {
      return kwType === "income" ? allIncomeCategories() : allCategories();
    }
    function customCategoryList() {
      return kwType === "income" ? state.customIncomeCategories : state.customCategories;
    }
    function customStore() {
      return kwType === "income" ? state.incomeCategoryKeywords : state.categoryKeywords;
    }

    function renderCategorySelect() {
      categorySelect.innerHTML = categoryList().map(c => `<option value="${c.key}">${c.key}</option>`).join("");
    }

    // 新增分類要選色的色盤：一排固定的莫蘭迪色票，點一下就選定，選中的
    // 那個會有外框標示；跟旁邊的滑動式調色盤（<input type="color">）跟
    // 手動輸入色號的文字框三個互相同步，不管用哪一種方式選，另外兩個
    // 都會跟著更新。
    function renderSwatches() {
      swatchListEl.innerHTML = CUSTOM_CATEGORY_PALETTE.map(c => `
        <button type="button" class="swatch ${c.toLowerCase() === newCategoryColor.toLowerCase() ? "selected" : ""}" data-color="${c}" style="background:${c};" aria-label="選擇顏色 ${c}"></button>
      `).join("");
      swatchListEl.querySelectorAll("[data-color]").forEach(btn => {
        btn.addEventListener("click", () => {
          newCategoryColor = btn.getAttribute("data-color");
          colorPicker.value = newCategoryColor;
          colorHex.value = newCategoryColor;
          renderSwatches();
        });
      });
    }

    colorPicker.addEventListener("input", () => {
      newCategoryColor = colorPicker.value;
      colorHex.value = newCategoryColor;
      renderSwatches();
    });
    colorHex.addEventListener("input", () => {
      const v = colorHex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        newCategoryColor = v;
        colorPicker.value = v;
        renderSwatches();
      }
    });

    // 選好的分類（不管內建還是自訂）都可以在這裡調整「計入損益」；
    // 自訂分類另外多了改顏色跟刪除分類的功能——內建分類的顏色是寫死
    // 在 CSS 色票裡的莫蘭迪主色，維持整體配色一致，不開放更改。
    function renderCategorySettings() {
      const key = categorySelect.value;
      const cat = categoryList().find(c => c.key === key);
      if (!cat) { settingsEl.innerHTML = ""; return; }
      const isCustom = customCategoryList().some(c => c.key === key);
      const pl = countsTowardPL(key, kwType);

      let html = `
        <label class="checkbox-label" style="margin-top:10px;">
          <input type="checkbox" id="kwPLToggle" ${pl ? "checked" : ""}>
          <span>計入本月支出/收入統計（損益）</span>
        </label>`;
      if (isCustom) {
        html += `
          <label class="field-label">分類顏色</label>
          <div class="color-picker-row">
            <input type="color" id="kwEditColorPicker" class="color-well" value="${cat.color}">
            <input type="text" id="kwEditColorHex" class="text-input color-hex-input" maxlength="7" value="${cat.color}">
          </div>
          <button class="add-mini secondary" id="kwDeleteCategoryBtn" style="margin-top:10px;">🗑 刪除「${escapeHtml(key)}」這個自訂分類</button>`;
      }
      settingsEl.innerHTML = html;

      settingsEl.querySelector("#kwPLToggle").addEventListener("change", (e) => {
        if (!state.categoryPLOverrides) state.categoryPLOverrides = {};
        state.categoryPLOverrides[categoryPLKey(key, kwType)] = e.target.checked;
        saveState(state);
        renderChart();
        renderHome();
      });

      if (isCustom) {
        const editPicker = settingsEl.querySelector("#kwEditColorPicker");
        const editHex = settingsEl.querySelector("#kwEditColorHex");
        editPicker.addEventListener("input", () => {
          cat.color = editPicker.value;
          editHex.value = editPicker.value;
          saveState(state);
          renderChart();
        });
        editHex.addEventListener("input", () => {
          const v = editHex.value.trim();
          if (/^#[0-9a-fA-F]{6}$/.test(v)) {
            cat.color = v;
            editPicker.value = v;
            saveState(state);
            renderChart();
          }
        });
        settingsEl.querySelector("#kwDeleteCategoryBtn").addEventListener("click", () => {
          const list = customCategoryList();
          const idx = list.findIndex(c => c.key === key);
          if (idx !== -1) list.splice(idx, 1);
          renderCategorySelect();
          renderCategorySettings();
          renderChips();
          saveState(state);
          renderChart();
          renderHome();
        });
      }
    }

    function renderChips() {
      const key = categorySelect.value;
      const cat = categoryList().find(c => c.key === key);
      defaultChipsEl.innerHTML = (cat ? cat.keywords : [])
        .map(k => `<span class="chip default">${escapeHtml(k)}</span>`).join("")
        || `<span class="chip-empty">（無）</span>`;

      const custom = (customStore()[key] || []);
      customChipsEl.innerHTML = custom.length
        ? custom.map(k => `<span class="chip">${escapeHtml(k)}<button data-remove-kw="${escapeAttr(k)}">✕</button></span>`).join("")
        : `<span class="chip-empty">還沒有新增自訂關鍵字</span>`;

      customChipsEl.querySelectorAll("[data-remove-kw]").forEach(btn => {
        btn.addEventListener("click", () => {
          const kw = btn.getAttribute("data-remove-kw");
          customStore()[key] = (customStore()[key] || []).filter(k => k !== kw);
          renderChips();
          saveState(state);
        });
      });
    }

    kwTypeToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".type-btn");
      if (!btn) return;
      kwType = btn.getAttribute("data-type");
      kwTypeToggle.querySelectorAll(".type-btn").forEach(b => b.classList.toggle("active", b === btn));
      renderCategorySelect();
      renderCategorySettings();
      renderChips();
    });

    categorySelect.addEventListener("change", () => {
      renderCategorySettings();
      renderChips();
    });

    modalBody.querySelector("#kwAddBtn").addEventListener("click", () => {
      const kw = newInput.value.trim();
      if (!kw) return;
      const key = categorySelect.value;
      const store = customStore();
      if (!store[key]) store[key] = [];
      if (!store[key].includes(kw)) store[key].push(kw);
      newInput.value = "";
      renderChips();
      saveState(state);
    });

    newInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); modalBody.querySelector("#kwAddBtn").click(); }
    });

    // 新增一整個分類（不是關鍵字）：給名稱、用色盤/調色盤/色號選好的
    // 顏色、要不要計入損益，加進去之後直接選到它，方便馬上接著幫它加
    // 關鍵字。
    modalBody.querySelector("#kwAddCategoryBtn").addEventListener("click", () => {
      const name = newCategoryInput.value.trim();
      if (!name) return;
      if (categoryList().some(c => c.key === name)) {
        newCategoryHint.textContent = `「${name}」已經是一個分類了`;
        return;
      }
      const list = customCategoryList();
      const pl = newCategoryPLCheckbox.checked;
      list.push({ key: name, color: newCategoryColor, keywords: [], countsTowardPL: pl });
      customStore()[name] = [];
      newCategoryInput.value = "";
      newCategoryHint.textContent = "";
      // 下一個新分類預設顏色換下一個色票，選過的顏色不會一直重複。
      newCategoryColor = CUSTOM_CATEGORY_PALETTE[list.length % CUSTOM_CATEGORY_PALETTE.length];
      colorPicker.value = newCategoryColor;
      colorHex.value = newCategoryColor;
      newCategoryPLCheckbox.checked = true;
      renderSwatches();
      renderCategorySelect();
      categorySelect.value = name;
      renderCategorySettings();
      renderChips();
      saveState(state);
      renderChart();
    });

    newCategoryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); modalBody.querySelector("#kwAddCategoryBtn").click(); }
    });

    modalBody.querySelector("#kwDone").addEventListener("click", closeModal);

    renderCategorySelect();
    renderSwatches();
    renderCategorySettings();
    renderChips();
  }

  /* ================= 使用說明 =================
     左上角「拾光記帳」旁邊的 ⓘ 按鈕，點開是一份純瀏覽用的說明文件，
     照分頁順序把每個功能講一遍，之後新增功能記得回來這裡補一段。 */
  document.getElementById("guideBtn").addEventListener("click", openGuideModal);

  // 最後一段「有沒有雲端同步」看 cloudApi 有沒有初始化成功來決定內容：
  // 在 Claude Artifact 裡打開，cloudApi 是真的有東西，講同步；單獨存成
  // 檔案或部署成一般網頁打開，cloudApi 是 null，改成純粹的備份提醒。
  // 這樣同一份程式碼不管部署在哪裡，這段文字都會自動對，不用手動維護
  // 兩個版本。
  function guideSyncSection() {
    if (cloudApi) {
      return `
        <h4>☁ 同步與備份</h4>
        <ul>
          <li>右上角顯示「☁ 雲端同步中」代表資料會自動同步，同一個連結在不同裝置打開都會看到最新資料</li>
          <li>還是建議定期用「資料管理」的匯出功能備份一份文字，多一層保障</li>
        </ul>`;
    }
    return `
      <h4>💾 備份提醒</h4>
      <ul>
        <li>建議每隔一段時間（例如每 3 個月）就用「資料管理」裡的匯出功能備份一次文字紀錄</li>
        <li>資料是存在這個瀏覽器裡的，請不要清除瀏覽器的快取／瀏覽資料，清掉的話記帳資料會一起消失、無法復原</li>
      </ul>`;
  }

  function openGuideModal() {
    modalBody.innerHTML = `
      <h3>使用說明</h3>
      <div class="guide-content">
        <h4>🏠 首頁：快速記一筆</h4>
        <ul>
          <li>上方切換「支出」／「收入」</li>
          <li>打「花費項目」文字，系統會自動判斷分類（看得懂關鍵字），判斷不準或想加新分類，去「⚙ 管理分類」自己調整</li>
          <li>選擇支付方式：現金、銀行帳戶、信用卡（收入不能存進信用卡，所以收入只會看到現金跟銀行帳戶）</li>
          <li>用信用卡付的支出，會先算進那張卡「已刷卡未出帳」，等結帳日到了才會轉成「本期應繳」</li>
        </ul>

        <h4>📊 圖表</h4>
        <ul>
          <li>支出、收入分開各一個圓餅圖，用左右箭頭切換月份</li>
          <li>點圖例裡任一分類，可以看那個月這個分類底下的逐筆明細</li>
          <li>「調整」這種只是校正餘額用的分類，預設不算進統計；每個分類算不算都可以在「管理分類」裡自己切換</li>
        </ul>

        <h4>🏦 帳戶</h4>
        <ul>
          <li>「現金」固定釘在最上面、不能刪除，點編輯可以直接調整目前現金餘額</li>
          <li>可以新增多個銀行帳戶，帳戶之間可以互轉（不算支出也不算收入）</li>
          <li>「資料管理」：把記帳紀錄整理成文字複製保存，也可以在保存好之後清空舊紀錄（帳戶、卡片、待辦、分類設定都不會被清掉）；建議每 3 個月備份一次，也別清瀏覽器快取</li>
        </ul>

        <h4>💳 信用卡</h4>
        <ul>
          <li>新增卡片時分別填「本期應繳」跟「已刷卡未出帳」，結帳日一到系統會自動把未出帳金額併入應繳金額</li>
          <li>按「✓ 已繳款」記一筆繳款，可以選「全部」或「自訂金額」，再選用什麼方式繳</li>
        </ul>

        <h4>📝 待辦（週期性繳費）</h4>
        <ul>
          <li>新增固定要繳的項目，設定每月幾號重置為未繳納</li>
          <li>可以選「手動勾選」（自己按已繳、選付款方式）或「自動扣款」（先設定好扣款方式跟要扣到哪個月，時間一到系統自動記一筆，不用自己按）</li>
        </ul>

        <h4>⚙ 管理分類</h4>
        <ul>
          <li>可以幫既有分類新增自訂關鍵字，讓自動判斷更準</li>
          <li>也可以整個新增自己的分類，用色票、滑動調色盤或直接輸入色號自訂顏色</li>
          <li>每個分類（內建、自訂都可以）都能設定「是否計入本月支出/收入統計」</li>
        </ul>

        ${guideSyncSection()}
      </div>
      <div class="modal-actions">
        <button class="btn-save" id="guideCloseBtn" style="flex:1;">知道了</button>
      </div>`;
    modalOverlay.classList.add("open");
    modalBody.querySelector("#guideCloseBtn").addEventListener("click", closeModal);
  }

  /* ================= 分頁切換 ================= */
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));
      // 切分頁時捲回最上面，避免停在上個分頁的捲動位置：手機版捲動是在
      // .content 內部（見 style.css 的手機 media query），桌機預覽版
      // 捲動的是整個視窗，兩個都重置才能涵蓋兩種情況。
      const contentEl = document.querySelector(".content");
      if (contentEl) contentEl.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: "instant" });

      const titles = {
        home: "今天想記點什麼？",
        chart: "看看這個月花去哪了",
        accounts: "帳戶總覽",
        cards: "信用卡管理",
        checklist: "本月固定支出"
      };
      document.getElementById("pageTitle").textContent = titles[tab] || "拾光記帳";
    });
  });

  /* ================= 初始化 ================= */
  function initDate() {
    const now = new Date();
    const days = ["日","一","二","三","四","五","六"];
    document.getElementById("todayDate").textContent =
      `${now.getMonth() + 1}/${now.getDate()} 週${days[now.getDay()]}`;
  }

  initDate();
  renderPaymentOptions(paymentSelect, { excludeCards: entryType === "income" });
  renderHome();
  renderChart();
  renderAccounts();
  renderCards();
  renderRecurring();
  embedStateInDom(state);

  initCloud();

  /* ---------------- PWA：註冊 Service Worker（離線快取） ----------------
     只有一般網頁環境（例如 GitHub Pages）才有意義；Claude Artifact
     環境沒有 sw.js 這個檔案可以註冊，失敗會被下面的 catch 靜默吸收。 */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* 開發環境或不支援時靜默略過，不影響一般網頁使用 */
      });
    });
  }

})();
