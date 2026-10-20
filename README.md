# 拾光獸

[![Tests](https://github.com/algae1217aglae-ui/shiguangshou/actions/workflows/test.yml/badge.svg)](https://github.com/algae1217aglae-ui/shiguangshou/actions/workflows/test.yml)

**Shiguangshou** · 替自己的應用找回照片，以及照片旁的那段對話。

本機圖片召回與可選的 90 天聊天照片清理。給聊天應用接入的 Node.js 原始碼套件，不是完整聊天網站。

同圖用 SHA-256，比較接近的版本用 pHash；可選 CLIP 整圖／固定裁切，以及 YOLO 偵測區域搭配 CLIP。SQLite 儲存特徵與來源，原圖保留在接入者指定的資料夾。模型分數只是相似度，**不能證明兩張照片是同一物件**。

## 快速開始

需要 Node.js 24 以上。GitHub Actions 在 Windows／Linux、Node.js 24 執行不含模型的測試與接入範例，結果可點上方徽章查看。模型流程另行驗證，不能由 CI 綠燈推論為跨平台模型通過。YOLO 準備腳本目前固定 Windows x64／Python 3.12 的套件版本與雜湊。

```sh
npm ci
npm test
npm run demo
npm run demo:cleanup
npm run example:chat
```

`npm ci` 會下載鎖定的 Node 依賴及其原生執行元件，但不下載 CLIP 或 YOLO 權重。

兩個 demo 都只在系統暫存目錄建立合成圖片與假聊天資料，完成後移除整個範例目錄。一般 demo 只預覽清理；`demo:cleanup` 實際刪除一張範例過期聊天圖，保留一張範例收藏圖，並同步 SQLite。兩者均不啟動 HTTP 服務、不使用帳號、不讀取你的既有照片。

一般 demo 的結果：

```json
{"recalledKind":"exact","candidateCount":1,"deletedCount":0,"pendingRepairCount":0,"oldChatPhotoExists":true,"savedPhotoExists":true}
```

## 接入自己的應用

### 直接使用命令列

不接聊天應用也能使用。先建立一個全新的資料夾，將自己的照片放進 `inbox`，並按下方來源格式填入聊天／相簿／手帳資料。`init` 會建立空白來源檔，拒絕覆蓋既有資料夾。

```sh
node cli.mjs init --root ./my-photos
# 加入自己的圖片和來源資料後：
node cli.mjs index --root ./my-photos
node cli.mjs query --root ./my-photos --image inbox/query.jpg
node cli.mjs preview --root ./my-photos
```

查詢輸出 JSON，包括匹配、來源、附近對話、原圖路徑與警告，已經過末端檔案和政策重驗。`query.jpg` 也必須放在允許根內；不想它成為歷史候選，就不要把它加入來源資料。`--before 2026-01-01T12:00:00Z` 可限定歷史截止時間。

模型準備完成後，`index` 和 `query` 都加 `--clip` 使用整圖與固定裁切，加 `--yolo` 使用 YOLO 區域；查詢另加 `--candidates` 可輸出未確認的不同角度候補。它只在本機回傳結果，不傳照片給聊天模型。索引結果若有 pending，需再執行 index 重試；query 仍受 2500ms 時限約束，冷啟動可能降級。

清理只在明確執行下列命令時發生，沒有背景自動開關：

```sh
node cli.mjs cleanup --root ./my-photos --execute
node cli.mjs repair --root ./my-photos
node cli.mjs revoke --root ./my-photos --image inbox/photo.jpg
```

先看 preview，再決定是否 execute。`repair` 修復刪圖後未完成的索引同步；`revoke` 撤回圖片召回資格，不刪原圖。CLI 的索引與清理共用跨程序鎖；手動編輯來源或由其他應用寫入時，請先停清理，或依下文使用同一把鎖。

### 使用 JavaScript API

最小聊天接入見 [`examples/chat-integration.mjs`](examples/chat-integration.mjs)：一般 `user`／`assistant` 訊息、明確 `memorySafe`、真 worker／SQLite，再將重驗後的圖片和對話交給呼叫端。它使用合成圖片，不呼叫外部模型 API。

包含清理的完整可執行例子見 [`examples/local-demo.mjs`](examples/local-demo.mjs)。它展示政策初始化、真 worker、索引、查詢、清理與關閉。根目錄各 `.mjs` 可直接 import，不必啟動原應用。

```js
import { createImageMemoryClient } from './image-memory.mjs';
import { initializeImageMemoryPolicyAsync } from './image-memory-policy.mjs';

await initializeImageMemoryPolicyAsync(policyPath); // 新資料庫顯式初始化；不可刪掉舊政策重建來解除撤回
const client = createImageMemoryClient({
  enabled: true,
  workerPath, // 本套件 tools/image-memory/worker.mjs 的絕對路徑
  cwd: packageRoot,
  inboxDir, dbPath, policyPath, // 接入者自己的絕對路徑
});
try {
  await client.indexBatch([{
    occurrenceId: 'message-1:image-0', relativePath: 'inbox/photo.jpg',
    sourceTs: Date.parse('2026-01-01T12:00:00Z'), sourceText: 'A saved photo',
  }]);
  const result = await client.recallBatch({
    queries: [{ queryId: 'query-1', occurrenceId: 'message-2:image-0', relativePath: 'inbox/query.jpg' }],
    beforeTs: Date.now(), excludeOccurrenceIds: ['message-2:image-0'],
  });
  // 先檢查 channels/warnings；使用前重驗來源、政策和檔案，不能把舊結果當永久附件。
} finally { await client.close(); }
```

- `inboxDir` 必填；`lifePhotosDir`、`galleryDir` 為另外兩個可選圖片根。相對路徑固定 `inbox/檔名`、`life-photos/檔名`、`gallery/檔名`，不接受任意檔案路徑。檔案上限 20 MiB、40M pixels，支援 JPEG/PNG/WebP/GIF；動畫只處理首格。
- `sourceTs` 是毫秒時間戳，`occurrenceId` 必須由你的應用提供穩定的每次分享識別碼。同 SHA 可以合併圖片，但不合併不同分享的身份與對話。
- `client.revoke(paths)` 處理撤回；`client.reconcile()` 清除失效路徑。撤回政策缺失、損壞或暫停時停止召回。別直接編輯 SQLite 去繞過政策。
- `indexBatch`／`backfill` 回 `indexed`、`unchanged`、`failed`、`pendingEmbedding`，開啟區域時也有 `pendingRegions`。pending 需要背景重試，不能當成模型已索引完成。
- 圖片本身無法建索引時（超過像素或檔案上限、格式不支援、無法解碼、檔案不存在或路徑不合法），該張計入 `unindexable` 並在 `codes` 留下原因，不算 `failed`；整批來源提交也只略過那一張，其餘照常提交（提交結果帶 `unindexable`、`unindexableCodes`）。來源資料夾暫時讀不到、讀取中檔案變動等暫時性錯誤仍算失敗並重試。`unindexable` 只在大於 0 時出現。
- `recallBatch` 回 `matches`、`warnings` 和通道狀態；預設最多 3 張歷史圖、8 張查詢圖、2500ms 共用時限。模型失敗時仍可走 hash；它不保證每次找到候選。
- `syncSourceSnapshot` 的整批提交使用獨立背景期限 `sourceSyncTimeoutMs`，預設及最大 60000ms，可設更短的正數毫秒；不會延長聊天召回的 `timeoutMs`。背景提交仍共用 worker，繁忙時查詢可能逾時降級。
- `indexBatch`／`backfill`／`reconcile` 同樣使用獨立背景期限 `maintenanceTimeoutMs`，預設及最大 60000ms；不再套用聊天召回的 `timeoutMs`，避免排隊時間讓正常寫入逾時、worker 被終止。
- worker 因逾時或異常結束而進入冷卻（`cooldownMs`）後，冷卻一結束 client 會自動重新啟動 worker 讓模型預熱，下一次查詢不必先撞上冷啟動。預設開啟，設 `prewarmAfterCooldown: false` 可關閉；`close()` 會取消尚未觸發的預熱。

### 來源與照片附近聊天

`image-memory-sources.mjs` 提供 chat／life／album 來源快照；`image-memory-backfill.mjs` 提供增量回填。現成轉接格式如下，若你的應用格式不同，先明確轉換，不能假設未讀到就是沒有收藏：

使用 `createImageMemoryBackfillRunner` 時，呼叫端需依 `run()` 回傳的 `retryAfterMs` 安排下一次執行。連續回傳失敗時為 1、2、4、8、16、30 分鐘，最多 30 分鐘；恢復後重設。只有特徵尚待完成時仍為 1 分鐘，完成則回 null。拋出的例外仍需呼叫端捕捉並有界退避；套件不自動啟動排程或合併宿主日誌。

```text
state.json             {"log":[{"messageId":"m1","conversationId":"c1","role":"user","ts":"ISO時間","text":"...","images":["inbox/a.jpg"]}]}
chat-history.jsonl     每行一則上述訊息，以換行結束
life.json              [{"id":"entry-1","kind":"photo","photo":"inbox/a.jpg","ts":"ISO時間","text":"..."}]
albums.json            {"albums":[{"id":"album-1","name":"Saved","items":[{"id":"item-1","src":"inbox/a.jpg","at":"ISO時間"}]}]}
```

`memorySafe:false`、hidden/private 等排除設定依來源處理。內建少量中文私密提示詞只是額外防線，不是能理解所有語言的隱私分類器；接入者應明確提供 `memorySafe:false`。

照片附近對話最多前 2 則、後 3 則，限同一段對話、10 分鐘內且早於查詢；遇隱私或段落邊界不跨過去補滿。文字標為舊資料，不能當指令執行。

`image-memory-chat.mjs` 的 `revalidateImageRecallForBridge`／`prepareImageRecallBridgeDispatch` 可在送出前重驗 query、live source、policy、path/SHA，並組裝文字和原圖路徑。詳見 `chat-image-recall.test.mjs` 的完整呼叫。你仍需在自己真正送圖的位置接入此步驟。

### 不同角度候補

嚴格門檻預設仍是 0.88。`angleFallbackEnabled:true` 可啟用 whole/fixed 前列交集的「未確認候補」，預設關閉，不自動升格為同物件或寫入長期記憶。與嚴格結果共用圖數及時間限制。

0.2.1 起，候補須在同一 query 下同時符合整圖相似度至少 **0.75**、fixed 區域相似度至少 **0.80**，並仍在兩路原始前三名交集中。worker 挑選與送圖前重驗都套用此限制；高 YOLO 分數不能單獨放行，raw 診斷分數仍可保留。這是尚未經跨物件評估集校準的試用底線，可能同時減少誤召回與正確候補；相似度不是身份確認機率。

候補計算與送圖使用明確能力 `supportsImageAttachments:true`，不判斷模型或產品名稱。`prepareImageRecallBatch`／`handleImageMemoryChatRoute` 與 `prepareImageRecallBridgeDispatch` 皆須傳入此能力及 `angleFallbackEnabled:true`；能力省略或為 false 時，停用候補計算／注入。CLI 直接本機輸出不受橋接名稱限制。套件不呼叫聊天模型 API，也不保證下游模型完成視覺核對。

### 從 0.1 升級

核心訊息採 `role: 'user' | 'assistant'`，保留 `ts`、`messageId`、`conversationId`、`text`、`images`、隱私欄位；文字不再解讀宿主特殊標籤。手帳來源的助理作者用 `author:'assistant'`。舊宿主格式可在寫入來源前使用可選的 [`adapters/legacy-chat.mjs`](adapters/legacy-chat.mjs)，核心不載入它。不要過濾掉轉接後的 hidden／memorySafe:false 邊界訊息。

原 `bridgeKind` 改傳 `supportsImageAttachments`；需要舊產品路由規則者可明確呼叫 `adaptLegacyBridgeOptions`。提示組裝的 `forcedGlmPromptText`／`fallbackGlmPromptText` 改為中性的 `plainPromptText`。SQLite 繼續讀取 0.1 的內部作者編碼，API 回傳 assistant，無須刪除索引或撤回政策。

這仍是原始碼套件；`private:true` 防止誤發 npm，不妨礙 clone、CLI 或本地 import 使用，尚未在 npm 發布。

## 可選本機模型

### CLIP

以下是**明確下載模型**的步驟，會連 Hugging Face：

```sh
node tools/image-memory/prepare-model.mjs --manifest tools/image-memory/model-manifest.json --cache tools/image-memory/model-cache
```

清單固定 Xenova/clip-vit-base-patch32 的 revision、fp32 及特徵版本。正常推論只使用本機檔案。建立 client 時另傳絕對路徑 `manifestPath`、`cacheDir`、`embeddingWorkerPath`（tools/image-memory/embedding-worker.mjs）。加上 `regionsEnabled:true` 可使用固定裁切；沒有 YOLO 也能跑。

### YOLO

需要你自己已安裝的 Python 3.12。先看下載計畫，再執行：

```sh
node tools/image-region/prepare-detector.mjs --python "你的Python3.12執行檔" --dry-run
node tools/image-region/prepare-detector.mjs --python "你的Python3.12執行檔"
```

只在 tools/image-region/runtime 建立獨立環境；下載套件和權重、核對固定版本／SHA、保存上游授權，正常 detector 推論停用網路。runtime、權重及套件環境不隨這份原始碼發布。準備完成後，client 再傳 `regionsEnabled:true`、`detectorManifestPath`、`detectorWorkerPath` 的絕對路徑。現有準備器不宣稱支援非 Windows 環境。

YOLO 框只是輔助裁切，不能直接認定同物件；預訓練類別也不包含所有日常物品。背景 detector 和即時查詢有不同時限，逾時可退回固定裁切／整圖／hash。

## 可選 90 天清理

**預設關閉，核心不自行啟動排程。** 請先接好收藏資料與寫入鎖，再考慮執行。

```js
import { previewImageRetention } from './image-retention.mjs';
import { executeImageRetention } from './image-retention-executor.mjs';

const preview = await previewImageRetention({ root: yourDataRoot, days: 90 });
// 用預覽結果確認範圍後，才由你的應用明確啟用：
const result = await executeImageRetention({
  root: yourDataRoot, enabled: true, days: 90,
  reconcile: () => client.reconcile(),
});
```

`yourDataRoot` 要有上述四份來源檔案和 inbox。只刪聊天明確分享、最後可信分享超過 90 天的 inbox 直屬圖；不掃孤兒檔、不刪聊天文字、不處理 gallery/life-photos。相簿、手帳 `photo`、旅遊 `travel.stops[].photo`／`travel.group.photo` 保護原圖及同 SHA 別名，hidden/private 收藏也保護。作品 HTML 不在永久保護來源內。

必要來源缺失、格式錯誤、時間不可信、檔案被替換等情況保守停止或略過。刪檔成功而索引同步失敗時保留匿名 pending，必須持續用 `repairPendingImageRetention` 修復；`pendingRepairCount>0` 不是完整成功。

**並行寫入必須接鎖**：所有聊天重分享、相簿／手帳收藏寫入與索引修改，用 `image-retention-fence.mjs` 的 `withImageRetentionClaims`；`relativePaths` 傳涉及的相對路徑，索引修改使用 `['__index__']`，持有至檔案複製和最新 metadata 保存完成。不要把鎖持有到聊天模型整輪結束。外部程式若繞過這些鎖，套件不能保證清理與收藏的並行安全。

有需要可自行接 `createImageRetentionScheduler`（至少6小時）及 `createImageRetentionRepairScheduler`。可選 HTTP handler 僅接受持 token 的本機 JSON 請求，檢查 Host/Origin/反代標頭；套件本身不開埠。不能直接當對公網服務使用。

## 驗證與限制

- `npm test` 使用合成資料，涵蓋 worker、SQLite、撤回、來源、區域協定、附件重驗、清理與HTTP驗證，不會下載模型。
- 真 CLIP、YOLO 及 Python 座標測試需要事先準備模型／Python，預設會明示 skip；skip 不代表驗過。可設 `IMAGE_MEMORY_MODEL_TEST=1`、`IMAGE_REGION_MODEL_TEST=1`、`IMAGE_REGION_PYTHON=你的Python` 執行對應測試。請先看各 integration.test.mjs 的額外條件。
- 本版沒有公開的跨物件標記評估集，也沒有聲稱不同角度的識別准确率。閾值未為你的照片集合校準。
- 特徵、來源文字與政策也是私人資料，需由接入應用限制存取。本套件沒有多租戶權限系統、資料加密或備份銷毀保證。原圖清理不會刪除你另存的備份。

## 授權

本專案以 **AGPL-3.0-only** 發布，見 [LICENSE](LICENSE)。分享修改版或提供修改版的網路互動服務時，需依條款向相應接收者／使用者提供對應原始碼；允許商用。接入者需評估自己結合的應用所受授權義務，不能假設只有這個小模組要公開。

第三方程式、原生執行元件及模型各保留原授權，見 [THIRD_PARTY.md](THIRD_PARTY.md)。AGPL 不要求發布使用者照片、聊天紀錄或金鑰。不要把執行期資料放入公開儲存庫。

## 開發與資料檔

請把真實使用資料放在專案外。`.gitignore` 僅忽略執行期目錄、已知來源檔、照片／模型／金鑰格式，不再忽略所有 JSON；新 manifest 與合成 JSON fixture 能正常提交。每次 push／PR 跑 Windows 和 Linux 無模型 CI，工作流程只有 contents:read 權限，不含私有服務憑證。
