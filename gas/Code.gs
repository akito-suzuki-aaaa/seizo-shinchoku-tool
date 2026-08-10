/* =============================================================
   Code.gs  —  GAS バックエンド（セキュア版）
   -------------------------------------------------------------
   セキュリティ方針:
   ・データはトークン認証必須（URLを知っていても、ログインしないと何も返さない）
   ・顧客はサーバー側で「自分の案件だけ」に絞って返す（他社データは送らない）
   ・写真は Drive で非公開（リンク共有しない）。認証API経由でのみ配信
   ・パスワードはハッシュ化して保存（顧客はcustomersシート、社員は共通パスワード）
   ・ログイン試行のレート制限あり

   社員共通パスワードの変更:
     Apps Scriptエディタで setEmployeePassword("新しいパスワード") を1回実行
   既存写真の共有解除（初回のみ）:
     employeeログイン後に画面から実行、または lockdownPhotos_manual() を実行
   ============================================================= */

const SHEETS = {
  customers: ["id", "company", "loginId", "passHash", "salt"],
  projects:  ["id", "name", "customerId", "customerName", "owner", "startDate", "dueDate", "status"],
  processes: ["id", "projectId", "name", "order", "targetQty"],
  logs:      ["id", "projectId", "processId", "datetime", "author", "progress", "status", "qty", "comment", "photo"],
};
const PHOTO_FOLDER = "進捗管理_写真";
const SESSION_TTL_MS = 12 * 3600 * 1000;      // トークン有効期間 12時間
const DEFAULT_EMP_PASSWORD = "shain-2026";     // 社員共通パスワード初期値（必ず変更してください）

/* ---------- 初期セットアップ（新規スプレッドシート） ---------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const [name, headers] of Object.entries(SHEETS)) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  const c1 = makeSalt(), c2 = makeSalt();
  appendRows("customers", [
    ["C001", "A社", "a-sha", hashPw("1234", c1), c1],
    ["C002", "B社", "b-sha", hashPw("1234", c2), c2],
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
  setEmployeePasswordInternal(DEFAULT_EMP_PASSWORD);
  PropertiesService.getScriptProperties().setProperty("schema", "2");
}

/* ---------- 初回だけ実行される初期化・移行 ---------- */
function ensureInitialized() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("schema") === "2") return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName("logs")) { setup(); return; }
  migrateCustomersToHash();                              // 既存の平文パスワードをハッシュ化
  if (!props.getProperty("emp_hash")) setEmployeePasswordInternal(DEFAULT_EMP_PASSWORD);
  props.setProperty("schema", "2");
}

// 既存 customers（id,company,loginId,password）を（…,passHash,salt）に変換
function migrateCustomersToHash() {
  const sh = sheet("customers");
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  if (headers.indexOf("passHash") >= 0) return;
  const iId = headers.indexOf("id"), iCo = headers.indexOf("company"),
        iLg = headers.indexOf("loginId"), iPw = headers.indexOf("password");
  const out = [["id", "company", "loginId", "passHash", "salt"]];
  for (let r = 1; r < values.length; r++) {
    if (!values[r][iId]) continue;
    const salt = makeSalt();
    out.push([values[r][iId], values[r][iCo], values[r][iLg], hashPw(String(values[r][iPw]), salt), salt]);
  }
  sh.clear();
  sh.getRange(1, 1, out.length, 5).setValues(out);
  sh.getRange(1, 1, 1, 5).setFontWeight("bold");
  sh.setFrozenRows(1);
}

/* ---------- ルーティング ---------- */
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    return json({ ok: true, data: route(req.action, req) });
  } catch (err) {
    const msg = String(err && err.message || err);
    return json({ ok: false, error: msg, auth: msg === "AUTH" });
  }
}
function doGet() { return json({ ok: true, data: "製造進捗管理API 稼働中" }); }

function route(action, req) {
  ensureInitialized();
  switch (action) {
    case "login":          return login(req.loginId, req.password);
    case "employeeLogin":  return employeeLogin(req.password);
    case "getBundle":      return getBundleData(req.token);
    case "getPhotoData":   return { dataUrl: getPhotoData(req.token, req.url) };
    case "getPhotos":      return { photos: getPhotosData(req.token, req.ids) };
    case "addLog":         return addLog(req.token, req.log);
    case "overwritePhoto": return overwritePhoto(req.token, req.logId, req.oldUrl, req.newDataUrl);
    case "lockdownPhotos": return lockdownPhotos(req.token);
    default: throw new Error("unknown action: " + action);
  }
}

/* ---------- パスワード・ハッシュ ---------- */
function makeSalt() { return Utilities.getUuid().replace(/-/g, "").slice(0, 16); }
function hashPw(pw, salt) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + "|" + pw, Utilities.Charset.UTF_8);
  return raw.map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}
function setEmployeePasswordInternal(pw) {
  const salt = makeSalt();
  const props = PropertiesService.getScriptProperties();
  props.setProperty("emp_salt", salt);
  props.setProperty("emp_hash", hashPw(pw, salt));
}
// エディタから手動実行して社員共通パスワードを変更する
function setEmployeePassword(pw) { setEmployeePasswordInternal(pw); return "変更しました"; }

/* ---------- レート制限（ログイン試行） ---------- */
function rateLimit(key) {
  const cache = CacheService.getScriptCache(), k = "rl:" + key;
  const n = Number(cache.get(k) || "0") + 1;
  cache.put(k, String(n), 600); // 10分間
  if (n > 8) throw new Error("試行回数が多すぎます。しばらく待ってください");
}

/* ---------- セッション（トークン） ---------- */
function createSession(role, refId) {
  const token = Utilities.getUuid();
  PropertiesService.getScriptProperties()
    .setProperty("sess_" + token, JSON.stringify({ role, refId, exp: Date.now() + SESSION_TTL_MS }));
  return token;
}
function getSession(token) {
  if (!token) return null;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("sess_" + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (Date.now() > s.exp) { props.deleteProperty("sess_" + token); return null; }
  return s;
}
function requireSession(token) { const s = getSession(token); if (!s) throw new Error("AUTH"); return s; }
function requireEmployee(token) { const s = requireSession(token); if (s.role !== "employee") throw new Error("権限がありません"); return s; }

/* ---------- ログイン ---------- */
function login(loginId, password) {
  rateLimit("cust:" + loginId);
  const c = readAll("customers").find(x => String(x.loginId) === String(loginId));
  if (!c || hashPw(String(password), c.salt) !== String(c.passHash)) throw new Error("IDまたはパスワードが違います");
  return { token: createSession("customer", c.id), id: c.id, company: c.company, role: "customer" };
}
function employeeLogin(password) {
  rateLimit("emp");
  const props = PropertiesService.getScriptProperties();
  const salt = props.getProperty("emp_salt"), hash = props.getProperty("emp_hash");
  if (!salt || hashPw(String(password), salt) !== hash) throw new Error("パスワードが違います");
  return { token: createSession("employee", "emp"), role: "employee" };
}

/* ---------- データ取得（トークン必須・顧客は自分の分だけ） ---------- */
function getBundleData(token) {
  const s = requireSession(token);
  const ver = bundleVer();
  const key = "bundle_" + (s.role === "customer" ? s.refId : "emp") + "_" + ver;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  let projects = readAll("projects"), processes = readAll("processes"), logs = readAll("logs");
  if (s.role === "customer") {
    const mine = {};
    projects = projects.filter(p => p.customerId === s.refId);
    projects.forEach(p => mine[p.id] = 1);
    processes = processes.filter(p => mine[p.projectId]);
    logs = logs.filter(l => mine[l.projectId]);
  }
  const data = { projects, processes, logs, role: s.role };
  const str = JSON.stringify(data);
  if (str.length < 95000) { try { cache.put(key, str, 40); } catch (e) {} }
  return data;
}
function bundleVer() { return PropertiesService.getScriptProperties().getProperty("bundleVer") || "0"; }
function invalidateBundle() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty("bundleVer", String(Number(bundleVer()) + 1));
}

/* ---------- 記録の追加（社員のみ） ---------- */
function addLog(token, log) {
  requireEmployee(token);
  const id = "L" + Date.now();
  const photos = log.photos || (log.photo ? [log.photo] : []);
  const ids = photos.map((p, i) =>
    (String(p).indexOf("data:image") === 0) ? savePhoto(p, id + "_" + i, log.projectId) : extractDriveId(p)
  ).filter(Boolean);
  const photoCell = ids.join("\n");
  appendRows("logs", [[
    id, log.projectId, log.processId, log.datetime, log.author,
    log.progress, log.status, log.qty, log.comment, photoCell,
  ]]);
  updateProjectStatus(log.projectId, log.status);
  invalidateBundle();
  return Object.assign({}, log, { id, photo: photoCell });
}

/* ---------- 写真の上書き（社員のみ・同一ファイルを直接差し替え） ---------- */
function overwritePhoto(token, logId, oldRef, newDataUrl) {
  requireEmployee(token);
  const oldId = extractDriveId(oldRef);
  const m = String(newDataUrl).match(/^data:(image\/\w+);base64,(.+)$/);
  if (!oldId || !m) throw new Error("画像データが不正です");
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], oldId + ".jpg");
  Drive.Files.update({}, oldId, blob);
  invalidateBundle();
  return { photo: currentPhotoCell(logId), newUrl: oldId, sameFile: true };
}
function currentPhotoCell(logId) {
  const sh = sheet("logs"), rows = sh.getDataRange().getValues();
  const H = SHEETS.logs, iId = H.indexOf("id"), iPhoto = H.indexOf("photo");
  for (let r = 1; r < rows.length; r++) if (rows[r][iId] === logId) return String(rows[r][iPhoto]);
  return "";
}

/* ---------- 写真の配信（認証API・顧客は自分の分だけ） ---------- */
function getPhotoData(token, ref) {
  const s = requireSession(token);
  const id = extractDriveId(ref);
  if (!id) throw new Error("画像が見つかりません");
  if (s.role === "customer" && !customerOwnsPhoto(s.refId, id)) throw new Error("権限がありません");
  const blob = DriveApp.getFileById(id).getBlob();
  return "data:" + blob.getContentType() + ";base64," + Utilities.base64Encode(blob.getBytes());
}
function customerOwnsPhoto(customerId, fileId) {
  const mine = {};
  readAll("projects").forEach(p => { if (p.customerId === customerId) mine[p.id] = 1; });
  return readAll("logs").some(l => mine[l.projectId] && String(l.photo).indexOf(fileId) >= 0);
}

// 複数写真を1回でまとめて配信（先読み高速化用）
function getPhotosData(token, ids) {
  const s = requireSession(token);
  const out = {};
  let owned = null;
  (ids || []).slice(0, 24).forEach(ref => {
    const id = extractDriveId(ref);
    if (!id || out[id]) return;
    if (s.role === "customer") {
      if (owned === null) owned = customerOwnedFileIds(s.refId);
      if (!owned[id]) return;
    }
    try {
      const b = DriveApp.getFileById(id).getBlob();
      out[id] = "data:" + b.getContentType() + ";base64," + Utilities.base64Encode(b.getBytes());
    } catch (e) {}
  });
  return out;
}
// 顧客が閲覧してよい写真fileIdの集合を一度だけ作る
function customerOwnedFileIds(customerId) {
  const mine = {};
  readAll("projects").forEach(p => { if (p.customerId === customerId) mine[p.id] = 1; });
  const set = {};
  readAll("logs").forEach(l => {
    if (!mine[l.projectId]) return;
    String(l.photo).split(/\n+/).forEach(u => { const id = extractDriveId(u); if (id) set[id] = 1; });
  });
  return set;
}

/* ---------- Drive 保存（非公開・共有しない） ---------- */
function savePhoto(dataUrl, id, projectId) {
  const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return "";
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], id + ".jpg");
  const file = projectFolder(projectId).createFile(blob);
  // 共有しない（リンクを知っていてもアクセス不可）。IDだけ保存し、配信は認証API経由。
  return file.getId();
}
function projectFolder(projectId) {
  const root = getFolder(PHOTO_FOLDER);
  const prj = projectId ? readAll("projects").find(p => p.id === projectId) : null;
  const name = prj ? sanitizeName(prj.customerName + "_" + prj.name) : "その他";
  return getSubFolder(root, name);
}
function getFolder(name) { const it = DriveApp.getFoldersByName(name); return it.hasNext() ? it.next() : DriveApp.createFolder(name); }
function getSubFolder(parent, name) { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : parent.createFolder(name); }
function sanitizeName(s) { return String(s).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80); }

/* ---------- 既存写真の共有解除（リンク共有をやめる） ---------- */
function lockdownPhotos(token) {
  requireEmployee(token);
  return lockdownPhotosCore();
}
function lockdownPhotos_manual() { return lockdownPhotosCore(); } // エディタから手動実行用
function lockdownPhotosCore() {
  let n = 0;
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  if (!it.hasNext()) return { locked: 0 };
  const root = it.next();
  n += unshareFiles(root.getFiles());
  const subs = root.getFolders();
  while (subs.hasNext()) n += unshareFiles(subs.next().getFiles());
  return { locked: n };
}
function unshareFiles(files) {
  let n = 0;
  while (files.hasNext()) {
    try { files.next().setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); n++; } catch (e) {}
  }
  return n;
}

/* ---------- 共通ユーティリティ ---------- */
function updateProjectStatus(projectId, status) {
  const sh = sheet("projects"), rows = sh.getDataRange().getValues();
  const idxId = SHEETS.projects.indexOf("id"), idxStatus = SHEETS.projects.indexOf("status");
  for (let r = 1; r < rows.length; r++) if (rows[r][idxId] === projectId) { sh.getRange(r + 1, idxStatus + 1).setValue(status); return; }
}
function extractDriveId(u) { const m = String(u).match(/[-\w]{25,}/); return m ? m[0] : ""; }
function sheet(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
function readAll(name) {
  const sh = sheet(name), values = sh.getDataRange().getValues(), headers = values.shift();
  return values.filter(r => r[0] !== "").map(row => { const o = {}; headers.forEach((h, i) => o[h] = row[i]); return o; });
}
function appendRows(name, rows) {
  const sh = sheet(name);
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
