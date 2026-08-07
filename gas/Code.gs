/* =============================================================
   Code.gs  —  GAS バックエンド（本番モード用）
   -------------------------------------------------------------
   使い方（README.md 参照）:
   1. Google スプレッドシートを新規作成
   2. 拡張機能 > Apps Script でこのコードを貼付
   3. setup() を一度実行 → シートとサンプルデータを自動作成
   4. デプロイ > 新しいデプロイ > 種類=ウェブアプリ
        実行するユーザー: 自分 / アクセスできるユーザー: 全員
   5. 発行された URL を store.js の GAS_URL に貼る
   ============================================================= */

const SHEETS = {
  customers: ["id", "company", "loginId", "password"],
  projects:  ["id", "name", "customerId", "customerName", "owner", "startDate", "dueDate", "status"],
  processes: ["id", "projectId", "name", "order", "targetQty"],
  logs:      ["id", "projectId", "processId", "datetime", "author", "progress", "status", "qty", "comment", "photo"],
};

// 写真を保存する Drive フォルダ名
const PHOTO_FOLDER = "進捗管理_写真";

/* ---------- 初期セットアップ（手動で1回実行） ---------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const [name, headers] of Object.entries(SHEETS)) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  // サンプルデータ
  appendRows("customers", [
    ["C001", "A社", "a-sha", "1234"],
    ["C002", "B社", "b-sha", "1234"],
  ]);
  appendRows("projects", [
    ["P001", "架台フレーム 100台", "C001", "A社", "鈴木", "2026-08-04", "2026-08-20", "作業中"],
    ["P002", "精密部品 加工", "C002", "B社", "田中", "2026-07-28", "2026-08-10", "完了"],
    ["P003", "タンク溶接", "C001", "A社", "佐藤", "2026-08-01", "2026-08-25", "作業中"],
  ]);
  appendRows("processes", [
    ["W001", "P001", "切断", 1, 100], ["W002", "P001", "溶接", 2, 100],
    ["W003", "P001", "塗装", 3, 100], ["W004", "P001", "検査", 4, 100],
    ["W005", "P002", "加工", 1, 500], ["W006", "P002", "検査", 2, 500],
    ["W007", "P003", "溶接", 1, 10],  ["W008", "P003", "塗装", 2, 10],
  ]);
  const t = new Date().toISOString();
  appendRows("logs", [
    ["L001", "P001", "W001", t, "鈴木", 100, "完了", 100, "材料切断100台分 完了。", ""],
    ["L002", "P001", "W002", t, "鈴木", 65, "作業中", 65, "溶接歪みなし。午後から仕上げ。", ""],
  ]);
}

// シートが未作成なら初回だけ自動でセットアップする
function ensureInitialized() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName("logs")) setup();
}

/* ---------- ルーティング ---------- */
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const data = route(req.action, req);
    return json({ ok: true, data });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

// 動作確認用（ブラウザで開くと OK が返る）
function doGet() {
  return json({ ok: true, data: "製造進捗管理API 稼働中" });
}

function route(action, req) {
  ensureInitialized();
  switch (action) {
    // 画面表示に必要なデータを1回でまとめて返す（round trip削減）
    case "getBundle":    return { projects: readAll("projects"), processes: readAll("processes"), logs: readAll("logs") };
    case "getProjects":  return readAll("projects");
    case "getProcesses": return readAll("processes").filter(p => p.projectId === req.projectId);
    case "getLogs":      return readAll("logs").filter(l => l.projectId === req.projectId);
    case "getAllLogs":   return readAll("logs");
    case "addLog":       return addLog(req.log);
    case "overwritePhoto": return overwritePhoto(req.logId, req.oldUrl, req.newDataUrl);
    case "getPhotoData": return { dataUrl: getPhotoData(req.url) };
    case "login":        return login(req.loginId, req.password);
    default: throw new Error("unknown action: " + action);
  }
}

/* ---------- 各処理 ---------- */
function addLog(log) {
  const id = "L" + Date.now();
  // 複数枚対応：dataURLはDriveへ保存、それ以外(既存URL)はそのまま。改行区切りで1セルに。
  const photos = log.photos || (log.photo ? [log.photo] : []);
  const urls = photos.map((p, i) =>
    (String(p).indexOf("data:image") === 0) ? savePhoto(p, id + "_" + i, log.projectId) : p
  ).filter(Boolean);
  const photoCell = urls.join("\n");
  appendRows("logs", [[
    id, log.projectId, log.processId, log.datetime, log.author,
    log.progress, log.status, log.qty, log.comment, photoCell,
  ]]);
  updateProjectStatus(log.projectId, log.status);
  return Object.assign({}, log, { id, photo: photoCell });
}

// 既存写真の1枚を、注釈付き画像で上書き（元ファイルはゴミ箱へ、行のURLを差し替え）
function overwritePhoto(logId, oldUrl, newDataUrl) {
  const sh = sheet("logs");
  const rows = sh.getDataRange().getValues();
  const H = SHEETS.logs;
  const iId = H.indexOf("id"), iPhoto = H.indexOf("photo"), iProj = H.indexOf("projectId");
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][iId] === logId) {
      const list = String(rows[r][iPhoto]).split("\n").map(s => s.trim()).filter(Boolean);
      const newUrl = savePhoto(newDataUrl, logId + "_" + Date.now(), rows[r][iProj]);
      const oldId = extractDriveId(oldUrl);
      const idx = list.findIndex(u => extractDriveId(u) === oldId);
      if (idx >= 0) { trashFile(oldId); list[idx] = newUrl; } else { list.push(newUrl); }
      const cell = list.join("\n");
      sh.getRange(r + 1, iPhoto + 1).setValue(cell);
      return { photo: cell, newUrl: newUrl };
    }
  }
  throw new Error("log not found: " + logId);
}

// 編集用に画像をdataURLで返す（CanvasのCORS汚染回避）
function getPhotoData(url) {
  const id = extractDriveId(url);
  const blob = DriveApp.getFileById(id).getBlob();
  return "data:" + blob.getContentType() + ";base64," + Utilities.base64Encode(blob.getBytes());
}

function extractDriveId(u) { const m = String(u).match(/[-\w]{25,}/); return m ? m[0] : ""; }
function trashFile(id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {} }

function login(loginId, password) {
  const c = readAll("customers").find(x => String(x.loginId) === String(loginId) && String(x.password) === String(password));
  if (!c) throw new Error("IDまたはパスワードが違います");
  return { id: c.id, company: c.company };
}

function updateProjectStatus(projectId, status) {
  const sh = sheet("projects");
  const rows = sh.getDataRange().getValues();
  const idxId = SHEETS.projects.indexOf("id");
  const idxStatus = SHEETS.projects.indexOf("status");
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][idxId] === projectId) {
      sh.getRange(r + 1, idxStatus + 1).setValue(status);
      return;
    }
  }
}

/* ---------- Drive に写真を保存（案件ごとのサブフォルダに振り分け） ---------- */
function savePhoto(dataUrl, id, projectId) {
  const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return "";
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], id + ".jpg");
  const folder = projectFolder(projectId);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // <img>で表示できる形式（uc?export=view は仕様変更で表示不可のため thumbnail を使う）
  return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w1200";
}
// 「進捗管理_写真 / 顧客名_案件名 /」の階層を用意して返す
function projectFolder(projectId) {
  const root = getFolder(PHOTO_FOLDER);
  const prj = projectId ? readAll("projects").find(p => p.id === projectId) : null;
  const name = prj ? sanitizeName(prj.customerName + "_" + prj.name) : "その他";
  return getSubFolder(root, name);
}
function getFolder(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function getSubFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function sanitizeName(s) { return String(s).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80); }

/* ---------- スプレッドシート ユーティリティ ---------- */
function sheet(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
function readAll(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return values.filter(r => r[0] !== "").map(row => {
    const o = {};
    headers.forEach((h, i) => o[h] = row[i]);
    return o;
  });
}
function appendRows(name, rows) {
  const sh = sheet(name);
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
