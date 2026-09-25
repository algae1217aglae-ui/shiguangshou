# 更新紀錄

## 0.2.0

- 一般聊天資料使用 user／assistant，移除核心對宿主特殊文字標籤、peekFile、語音及情緒欄位的處理。
- 新增可選 legacy adapter；保留隱私邊界。核心不依賴轉接檔。
- 候補計算和附件使用 supportsImageAttachments 明確能力，不再指定產品名稱。未提供能力時停用候補。
- prompt 輸出的兩個產品專用欄位合併為 plainPromptText。0.1 呼叫端需依 README 升級。
- SQLite 原有作者編碼保留，對外改為 assistant，不必重建資料或政策。
- 新增合成資料的完整中性聊天接入範例。
- GitHub Actions 在 Windows／Linux、Node 24 跑無模型測試與範例。
- 收窄 JSON 忽略規則、統一專案名稱。

## 0.1.0

首次公開：本機 hash／CLIP／YOLO 圖片召回、來源對話、未確認角度候補、CLI 與預設關閉的 90 天照片清理。
