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

  /* ---------- 認証トークン（ログイン状態） ---------- */
  const TOKEN_KEY = "mfg_token", ROLE_KEY = "mfg_role";
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(ROLE_KEY); } catch (e) {} }
  function setRole(r) { try { sessionStorage.setItem(ROLE_KEY, r); } catch (e) {} }
  function getRole() { try { return sessionStorage.getItem(ROLE_KEY) || ""; } catch (e) { return ""; } }
  const _photoCache = {};     // fileId -> dataURL
  const _photoInflight = {};  // fileId -> Promise（重複取得の防止）

  /* ---------- GAS 呼び出し（本番モード・トークン付き） ---------- */
  async function gas(action, payload) {
    const res = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, token: getToken(), ...payload }),
    });
    const json = await res.json();
    if (!json.ok) { const e = new Error(json.error || "APIエラー"); if (json.auth) e.auth = true; throw e; }
    return json.data;
  }

  /* ---------- 本番モード：全データを1回で取得してキャッシュ ---------- */
  // GASは1リクエストが遅いため、画面表示に必要なデータをまとめて1回だけ取得する。
  let _bundle = null;
  let _updateCb = null;             // 背景更新でデータが変わったら呼ぶ再描画用コールバック
  let _persistCache = true;         // 端末(localStorage)に保存してよいか（顧客画面ではoffにする）
  const BUNDLE_CACHE = "mfg_bundle_cache_v1";

  function normDate(v) {
    // スプレッドシート由来の日付(ISO)を YYYY-MM-DD に整える
    if (!v) return "";
    const s = String(v);
    return s.length >= 10 && s.indexOf("T") === 10 ? s.slice(0, 10) : s;
  }
  function normalizeBundle(b) {
    b.projects.forEach(p => { p.startDate = normDate(p.startDate); p.dueDate = normDate(p.dueDate); });
    return b;
  }
  function readBundleCache() { if (!_persistCache) return null; try { const s = localStorage.getItem(BUNDLE_CACHE); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function writeBundleCache(b) { if (!_persistCache) return; try { localStorage.setItem(BUNDLE_CACHE, JSON.stringify(b)); } catch (e) {} }

  async function fetchBundle() { return normalizeBundle(await gas("getBundle", {})); }

  // 背景で最新データを取得し、変化があれば再描画コールバックを呼ぶ
  async function refreshBundle() {
    try {
      const fresh = await fetchBundle();
      const changed = JSON.stringify(fresh) !== JSON.stringify(_bundle);
      _bundle = fresh; writeBundleCache(fresh);
      if (changed && _updateCb) _updateCb();
    } catch (e) {}
  }

  // stale-while-revalidate：キャッシュがあれば即返し、裏で最新化する
  async function bundle(force) {
    if (_bundle && !force) return _bundle;
    if (force) { await refreshBundle(); return _bundle; }
    const cached = readBundleCache();
    if (cached) { _bundle = cached; refreshBundle(); return _bundle; }
    _bundle = await fetchBundle(); writeBundleCache(_bundle);
    return _bundle;
  }

  const sortNewest = (arr) => arr.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

  /* ---------- 公開API（画面から呼ぶ） ---------- */
  return {
    isDemo,

    // 本番モードで最新データを取り直したいとき（送信後など）に呼ぶ
    async refresh() { if (!isDemo()) await bundle(true); },

    // 背景更新でデータが変わったときに呼ばれる再描画コールバックを登録
    onUpdate(cb) { _updateCb = cb; },

    // 端末への保存を無効化（顧客画面など、他社データを端末に残したくない場合）
    disableDiskCache() { _persistCache = false; try { localStorage.removeItem(BUNDLE_CACHE); } catch (e) {} },

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
      if (_bundle) { _bundle.logs.push(Object.assign({}, log, saved)); writeBundleCache(_bundle); }
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
      const id = (String(oldUrl).match(/[-\w]{25,}/) || [])[0];
      if (id) { Util._override[id] = newDataUrl; _photoCache[id] = newDataUrl; } // 直後は手元の描き込み画像で表示
      if (_bundle) { const l = _bundle.logs.find(x => x.id === logId); if (l) l.photo = res.photo; writeBundleCache(_bundle); }
      return res;
    },

    // 既存写真を編集用に取得（認証API経由・dataURL）
    async getPhotoData(url) {
      if (isDemo()) return url;
      const id = (String(url).match(/[-\w]{25,}/) || [])[0];
      if (id && Util._override[id]) return Util._override[id];
      if (id && _photoCache[id]) return _photoCache[id];
      const res = await gas("getPhotoData", { url: id || url });
      if (id) _photoCache[id] = res.dataUrl;
      return res.dataUrl;
    },

    // 顧客ログイン（トークン取得）
    async login(loginId, password) {
      if (isDemo()) {
        const c = load().customers.find(x => x.loginId === loginId && x.password === password);
        if (!c) throw new Error("IDまたはパスワードが違います");
        return { id: c.id, company: c.company, role: "customer" };
      }
      const r = await gas("login", { loginId, password });
      setToken(r.token); setRole("customer"); _bundle = null; try { localStorage.removeItem(BUNDLE_CACHE); } catch (e) {}
      return r;
    },

    // 社員ログイン（共通パスワード）
    async loginEmployee(password) {
      if (isDemo()) { setToken("demo-emp"); setRole("employee"); return { role: "employee" }; }
      const r = await gas("employeeLogin", { password });
      setToken(r.token); setRole("employee"); _bundle = null; try { localStorage.removeItem(BUNDLE_CACHE); } catch (e) {}
      return r;
    },

    logout() { clearToken(); _bundle = null; try { localStorage.removeItem(BUNDLE_CACHE); } catch (e) {} },
    hasToken() { return isDemo() ? true : !!getToken(); },
    role() { return isDemo() ? "employee" : getRole(); },

    // 写真を認証API経由で取得（fileId → dataURL）。メモリにキャッシュ＋重複取得防止。
    async getPhoto(ref) {
      if (!ref) return "";
      const s = String(ref);
      if (isDemo() || s.indexOf("data:") === 0) return s;
      const id = (s.match(/[-\w]{25,}/) || [])[0];
      if (!id) return "";
      if (Util._override[id]) return Util._override[id];
      if (_photoCache[id]) return _photoCache[id];
      if (_photoInflight[id]) return _photoInflight[id];
      const p = gas("getPhotoData", { url: id })
        .then(res => { _photoCache[id] = res.dataUrl; delete _photoInflight[id]; return res.dataUrl; })
        .catch(e => { delete _photoInflight[id]; throw e; });
      _photoInflight[id] = p;
      return p;
    },

    // 複数の写真を1回のリクエストでまとめて取得（先読み・高速化）
    async getPhotos(refs) {
      if (isDemo()) return;
      const ids = [...new Set((refs || [])
        .map(r => (String(r).match(/[-\w]{25,}/) || [])[0])
        .filter(id => id && !_photoCache[id] && !Util._override[id]))];
      if (!ids.length) return;
      try {
        const res = await gas("getPhotos", { ids });
        const map = res.photos || {};
        Object.keys(map).forEach(id => { _photoCache[id] = map[id]; });
      } catch (e) {}
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
  _override: {},   // 上書き直後、サムネ再生成を待たずに手元画像を表示するための一時差し替え
  photoUrl(raw) {
    if (!raw) return "";
    const s = String(raw);
    if (s.indexOf("data:") === 0) return s;
    const m = s.match(/[-\w]{25,}/);
    if (!m) return s;
    if (Util._override[m[0]]) return Util._override[m[0]];
    return `https://drive.google.com/thumbnail?id=${m[0]}&sz=w1200`;
  },
  // 保存された写真セル（改行区切り）を配列に分解
  splitPhotos(raw) {
    if (!raw) return [];
    return String(raw).split(/\n+/).map(s => s.trim()).filter(Boolean);
  },

  // <img data-ph="fileId"> を認証API経由の画像で埋める（描画後に呼ぶ）。
  // まず1回のリクエストでまとめて取得→各imgに反映（クリック時はキャッシュから即開く）。
  async hydratePhotos(root) {
    const scope = root || document;
    const imgs = [...scope.querySelectorAll("img[data-ph]")].filter(im => !im.dataset.phLoaded);
    if (!imgs.length) return;
    imgs.forEach(im => im.dataset.phLoaded = "1");
    await Store.getPhotos(imgs.map(im => im.getAttribute("data-ph")));
    imgs.forEach(im => Store.getPhoto(im.getAttribute("data-ph")).then(d => { if (d) im.src = d; }).catch(() => {}));
  },

  // 写真をポップアップで大きく表示。配列＋開始位置なら前後めくり。画像は認証API経由で読み込む。
  openImage(src, index) {
    const list = Array.isArray(src) ? src.slice() : [src];
    let i = index || 0;
    const ov = document.createElement("div");
    ov.className = "lightbox";
    ov.innerHTML = `
      <button class="lightbox-close" aria-label="閉じる">×</button>
      ${list.length > 1 ? '<button class="lightbox-nav lightbox-prev" aria-label="前へ">‹</button><button class="lightbox-nav lightbox-next" aria-label="次へ">›</button><div class="lightbox-count"></div>' : ''}
      <img alt="写真">`;
    const imgEl = ov.querySelector("img");
    const countEl = ov.querySelector(".lightbox-count");
    const show = async () => {
      if (countEl) countEl.textContent = `${i + 1} / ${list.length}`;
      const my = i;
      const d = await Store.getPhoto(list[i]);
      if (my === i) imgEl.src = d;
    };
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
  // 撮影画像を縮小して dataURL(JPEG) に変換（大きめ・きれいめ）
  fileToResizedDataUrl(file, maxSize = 1500, quality = 0.72) {
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
