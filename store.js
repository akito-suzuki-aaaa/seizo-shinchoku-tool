/* =============================================================
   store.js  —  データ層（3画面 共通）
   -------------------------------------------------------------
   ・GAS_URL が空 → デモモード（localStorage にデータを保存）
       3画面が同じブラウザ内でデータを共有します。
       まずはこのモードで動作・操作感を確認できます。
   ・GAS_URL を設定 → 本番モード（スプレッドシートに保存）
       gas/Code.gs をデプロイして得た URL を貼るだけで切替わります。
   ============================================================= */

const Store = (() => {

  /* ▼▼▼ 本番接続するときはここに GAS のデプロイURLを貼る ▼▼▼ */
  const GAS_URL = "https://script.google.com/macros/s/AKfycbzck7niD3DmeqBwLVk-yltqPfmzrtK6cr8-klh2hJJukRPOySHF6Gsi6ftiXy6r78bS/exec";
  /* ▲▲▲ 空のままだとデモモード（localStorage）で動きます ▲▲▲ */

  const LS_KEY = "mfg_progress_db_v1";
  const isDemo = () => !GAS_URL;

  /* ---------- サンプルデータ（初回だけ生成） ---------- */
  function seed() {
    const now = new Date();
    const iso = (d) => d.toISOString();
    const day = (n) => new Date(now.getTime() - n * 86400000);

    const customers = [
      { id: "C001", company: "A社", loginId: "a-sha", password: "1234" },
      { id: "C002", company: "B社", loginId: "b-sha", password: "1234" },
    ];

    const projects = [
      { id: "P001", name: "架台フレーム 100台", customerId: "C001", customerName: "A社", owner: "鈴木", startDate: "2026-08-04", dueDate: "2026-08-20", status: "作業中" },
      { id: "P002", name: "精密部品 加工", customerId: "C002", customerName: "B社", owner: "田中", startDate: "2026-07-28", dueDate: "2026-08-10", status: "完了" },
      { id: "P003", name: "タンク溶接", customerId: "C001", customerName: "A社", owner: "佐藤", startDate: "2026-08-01", dueDate: "2026-08-25", status: "作業中" },
    ];

    const processes = [
      { id: "W001", projectId: "P001", name: "切断",  order: 1, targetQty: 100 },
      { id: "W002", projectId: "P001", name: "溶接",  order: 2, targetQty: 100 },
      { id: "W003", projectId: "P001", name: "塗装",  order: 3, targetQty: 100 },
      { id: "W004", projectId: "P001", name: "検査",  order: 4, targetQty: 100 },
      { id: "W005", projectId: "P002", name: "加工",  order: 1, targetQty: 500 },
      { id: "W006", projectId: "P002", name: "検査",  order: 2, targetQty: 500 },
      { id: "W007", projectId: "P003", name: "溶接",  order: 1, targetQty: 10 },
      { id: "W008", projectId: "P003", name: "塗装",  order: 2, targetQty: 10 },
    ];

    const logs = [
      { id: "L001", projectId: "P001", processId: "W001", datetime: iso(day(2)), author: "鈴木", progress: 100, status: "完了",   qty: 100, comment: "材料切断100台分 完了。", photo: "" },
      { id: "L002", projectId: "P001", processId: "W002", datetime: iso(day(1)), author: "鈴木", progress: 65,  status: "作業中", qty: 65,  comment: "溶接歪みなし。午後から仕上げ。", photo: "" },
      { id: "L003", projectId: "P003", processId: "W007", datetime: iso(day(1)), author: "佐藤", progress: 40,  status: "作業中", qty: 4,   comment: "1基目 溶接中。", photo: "" },
      { id: "L004", projectId: "P002", processId: "W006", datetime: iso(day(0)), author: "田中", progress: 100, status: "完了",   qty: 500, comment: "全数検査合格。出荷準備完了。", photo: "" },
    ];

    return { customers, projects, processes, logs };
  }

  function load() {
    let db = null;
    try { db = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) {}
    if (!db) { db = seed(); save(db); }
    return db;
  }
  function save(db) { localStorage.setItem(LS_KEY, JSON.stringify(db)); }

  /* ---------- GAS 呼び出し（本番モード） ---------- */
  async function gas(action, payload) {
    const res = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...payload }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "APIエラー");
    return json.data;
  }

  /* ---------- 本番モード：全データを1回で取得してキャッシュ ---------- */
  // GASは1リクエストが遅いため、画面表示に必要なデータをまとめて1回だけ取得する。
  let _bundle = null;
  function normDate(v) {
    // スプレッドシート由来の日付(ISO)を YYYY-MM-DD に整える
    if (!v) return "";
    const s = String(v);
    return s.length >= 10 && s.indexOf("T") === 10 ? s.slice(0, 10) : s;
  }
  async function bundle(force) {
    if (_bundle && !force) return _bundle;
    const b = await gas("getBundle", {});
    b.projects.forEach(p => { p.startDate = normDate(p.startDate); p.dueDate = normDate(p.dueDate); });
    _bundle = b;
    return _bundle;
  }

  const sortNewest = (arr) => arr.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

  /* ---------- 公開API（画面から呼ぶ） ---------- */
  return {
    isDemo,

    // 本番モードで最新データを取り直したいとき（送信後など）に呼ぶ
    async refresh() { if (!isDemo()) await bundle(true); },

    async getProjects() {
      if (isDemo()) return load().projects;
      return (await bundle()).projects;
    },

    async getProcesses(projectId) {
      if (isDemo()) return load().processes.filter(p => p.projectId === projectId).sort((a,b)=>a.order-b.order);
      return (await bundle()).processes.filter(p => p.projectId === projectId).sort((a,b)=>a.order-b.order);
    },

    async getLogs(projectId) {
      if (isDemo()) return sortNewest(load().logs.filter(l => l.projectId === projectId));
      return sortNewest((await bundle()).logs.filter(l => l.projectId === projectId));
    },

    async getAllLogs() {
      if (isDemo()) return sortNewest(load().logs);
      return sortNewest([...(await bundle()).logs]);
    },

    async addLog(log) {
      // log.photos は写真の配列（dataURL）。セルには改行区切りで保存する。
      const photos = log.photos || (log.photo ? [log.photo] : []);
      if (isDemo()) {
        const db = load();
        log.id = "L" + Date.now();
        log.photo = photos.join("\n");
        delete log.photos;
        db.logs.push(log);
        const prj = db.projects.find(p => p.id === log.projectId);
        if (prj) prj.status = log.status;
        save(db);
        return log;
      }
      const payload = Object.assign({}, log, { photos });
      delete payload.photo;
      const saved = await gas("addLog", { log: payload });
      if (_bundle) _bundle.logs.push(Object.assign({}, log, saved));
      return saved;
    },

    // 既存写真を注釈付きで上書き（oldUrlの1枚を newDataUrl に差し替え）
    async overwritePhoto(logId, oldUrl, newDataUrl) {
      if (isDemo()) {
        const db = load();
        const lg = db.logs.find(l => l.id === logId);
        if (lg) {
          const arr = Util.splitPhotos(lg.photo);
          const idx = arr.indexOf(oldUrl);
          if (idx >= 0) arr[idx] = newDataUrl; else arr.push(newDataUrl);
          lg.photo = arr.join("\n");
          save(db);
        }
        return { ok: true };
      }
      const res = await gas("overwritePhoto", { logId, oldUrl, newDataUrl });
      if (_bundle) { const l = _bundle.logs.find(x => x.id === logId); if (l) l.photo = res.photo; }
      return res;
    },

    // 既存写真を編集用に取得（CORSで汚染されないよう dataURL で受け取る）
    async getPhotoData(url) {
      if (isDemo()) return url; // デモはそのまま dataURL
      const res = await gas("getPhotoData", { url });
      return res.dataUrl;
    },

    async login(loginId, password) {
      if (isDemo()) {
        const c = load().customers.find(x => x.loginId === loginId && x.password === password);
        if (!c) throw new Error("IDまたはパスワードが違います");
        return { id: c.id, company: c.company };
      }
      return gas("login", { loginId, password });
    },

    // デモデータを初期状態に戻す（動作確認用）
    resetDemo() { localStorage.removeItem(LS_KEY); },
  };
})();

/* ---------- 画面共通の小道具 ---------- */
const Util = {
  fmtDate(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth()+1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  fmtDay(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
  },
  // 写真URLを表示可能な形式に整える。
  // デモのdataURLはそのまま。ドライブのURL(uc?export=view 等)はファイルIDを取り出して
  // thumbnail形式に変換する（uc形式は<img>表示不可のため）。
  photoUrl(raw) {
    if (!raw) return "";
    const s = String(raw);
    if (s.indexOf("data:") === 0) return s;
    const m = s.match(/[-\w]{25,}/);
    return m ? `https://drive.google.com/thumbnail?id=${m[0]}&sz=w1200` : s;
  },
  // 保存された写真セル（改行区切り）を配列に分解
  splitPhotos(raw) {
    if (!raw) return [];
    return String(raw).split(/\n+/).map(s => s.trim()).filter(Boolean);
  },

  // 写真をポップアップで大きく表示。単一URLでも、配列＋開始位置でも可（配列なら前後めくり）。
  openImage(src, index) {
    const list = Array.isArray(src) ? src.map(Util.photoUrl) : [Util.photoUrl(src)];
    let i = index || 0;
    const ov = document.createElement("div");
    ov.className = "lightbox";
    ov.innerHTML = `
      <button class="lightbox-close" aria-label="閉じる">×</button>
      ${list.length > 1 ? '<button class="lightbox-nav lightbox-prev" aria-label="前へ">‹</button><button class="lightbox-nav lightbox-next" aria-label="次へ">›</button><div class="lightbox-count"></div>' : ''}
      <img src="${list[i]}" alt="写真">`;
    const imgEl = ov.querySelector("img");
    const countEl = ov.querySelector(".lightbox-count");
    const show = () => { imgEl.src = list[i]; if (countEl) countEl.textContent = `${i + 1} / ${list.length}`; };
    const go = (d, e) => { e && e.stopPropagation(); i = (i + d + list.length) % list.length; show(); };
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); else if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1); };
    ov.addEventListener("click", close);
    const prev = ov.querySelector(".lightbox-prev"), next = ov.querySelector(".lightbox-next");
    if (prev) prev.addEventListener("click", (e) => go(-1, e));
    if (next) next.addEventListener("click", (e) => go(1, e));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    show();
  },
  // 撮影画像を縮小して dataURL(JPEG) に変換（保存容量を抑える）
  fileToResizedDataUrl(file, maxSize = 900, quality = 0.6) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) { height = height * maxSize / width; width = maxSize; }
        else if (height > maxSize) { width = width * maxSize / height; height = maxSize; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      reader.readAsDataURL(file);
    });
  },
};
