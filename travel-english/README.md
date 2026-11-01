# 旅遊英文開口說（PWA）

給英文初學者（約國小程度）的旅遊英文口說練習。第一版：「餐廳點餐」場景。

## 檔案結構

```
travel-english/
├── index.html             # 入口頁（只有外框，畫面由 app.js 產生）
├── manifest.webmanifest   # PWA 設定（名稱、圖示、主題色）
├── sw.js                  # Service Worker：離線快取
├── css/style.css          # 樣式（手機優先、大按鈕）
├── js/
│   ├── app.js             # 路由與四個分頁的畫面邏輯
│   ├── speech.js          # 語音播放（speechSynthesis）＋語音辨識（SpeechRecognition）
│   ├── score.js           # 跟讀評分：逐字比對、0–100 分
│   └── storage.js         # 學習進度（localStorage）
├── data/
│   ├── scenes.json        # 場景清單（首頁卡片）
│   └── ordering.json      # 餐廳點餐課程內容
└── icons/                 # App 圖示
```

## 本機測試

瀏覽器不允許 `file://` 讀取 JSON，所以**不能直接雙擊 index.html**，要開一個本機伺服器：

```bash
cd travel-english
python3 -m http.server 8000      # 或：npx serve .
```

然後用 **Chrome** 打開 http://localhost:8000 。
（localhost 被當成安全連線，所以麥克風和離線功能都能用。）

## 新增場景

1. 照 `data/ordering.json` 的格式新增，例如 `data/airport.json`
2. 在 `data/scenes.json` 找到該場景，把 `available` 改成 `true`，加上 `"file": "data/airport.json"`
3. 在 `sw.js` 的 `APP_FILES` 加上新檔名，並把 `CACHE_VERSION` 改成 `v2`

## 注意事項

- **語音辨識**：Android Chrome、iPhone Safari（iOS 14.5+）、電腦版 Chrome/Edge 可用；Firefox 不支援（會顯示中文提示，改成「我已跟著唸完」按鈕）。
  Chrome 的語音辨識是送到 Google 伺服器處理的，**離線時無法評分**；其他功能（聽、句型、聽懂對方）離線都能用。
- **語音播放**：使用手機內建的英文語音，音色依裝置而不同。
- 麥克風只能在 `https://` 或 `localhost` 下使用。
