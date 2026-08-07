/* =============================================================
   annotate.js — 画像に矢印などを描き込む注釈エディタ（3画面 共通）
   -------------------------------------------------------------
   使い方:
     Annotator.open(src, onSave)
       src    … 画像URL または dataURL
       onSave … 保存時に呼ばれる。引数は描き込み後のJPEG(dataURL)
   スマホの指・PCのマウス両対応（Pointer Events）。
   ============================================================= */
const Annotator = (() => {
  const MAX = 1600; // 書き出しの最大辺（容量とアップ速度のバランス）

  function open(src, onSave) {
    const shapes = [];        // 確定した図形
    let cur = null;           // 描画中の図形
    let selected = null, dragging = false, last = null; // 選択・移動用
    let tool = "arrow";
    let color = "#e53935";
    let width = 6;

    const ov = document.createElement("div");
    ov.className = "anno";
    ov.innerHTML = `
      <div class="anno-bar anno-top">
        <button class="anno-btn" data-tool="move" title="選択・移動">✥ 選択</button>
        <button class="anno-btn" data-tool="arrow" title="矢印">➔ 矢印</button>
        <button class="anno-btn" data-tool="rect" title="四角">▢ 四角</button>
        <button class="anno-btn" data-tool="pen" title="ペン">✎ ペン</button>
        <button class="anno-btn" data-tool="text" title="文字">A 文字</button>
        <span class="anno-colors">
          <button class="anno-col" data-c="#e53935" style="background:#e53935"></button>
          <button class="anno-col" data-c="#fdd835" style="background:#fdd835"></button>
          <button class="anno-col" data-c="#1e88e5" style="background:#1e88e5"></button>
          <button class="anno-col" data-c="#43a047" style="background:#43a047"></button>
          <button class="anno-col" data-c="#ffffff" style="background:#fff"></button>
          <button class="anno-col" data-c="#111111" style="background:#111"></button>
        </span>
        <label class="anno-w">太さ<input type="range" min="2" max="18" value="6" id="annoW"></label>
      </div>
      <div class="anno-stage"><canvas class="anno-canvas"></canvas></div>
      <div class="anno-bar anno-bottom">
        <button class="anno-btn" id="annoDel">🗑 選択を削除</button>
        <button class="anno-btn" id="annoUndo">↶ 戻す</button>
        <button class="anno-btn" id="annoClear">全消去</button>
        <span style="flex:1"></span>
        <button class="anno-btn anno-cancel" id="annoCancel">キャンセル</button>
        <button class="anno-btn anno-save" id="annoSave">保存</button>
      </div>`;
    document.body.appendChild(ov);

    const canvas = ov.querySelector(".anno-canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.crossOrigin = "anonymous";

    function fitCanvasCss() {
      const stage = ov.querySelector(".anno-stage");
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const r = Math.min(sw / canvas.width, sh / canvas.height, 1);
      canvas.style.width = Math.round(canvas.width * r) + "px";
      canvas.style.height = Math.round(canvas.height * r) + "px";
    }

    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w, h) > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      canvas.width = w; canvas.height = h;
      fitCanvasCss();
      redraw();
    };
    img.onerror = () => { alert("画像の読み込みに失敗しました"); close(); };
    img.src = src;

    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      [...shapes, cur].filter(Boolean).forEach(drawShape);
      if (selected) {
        const b = bbox(selected);
        ctx.save();
        ctx.strokeStyle = "#1e88e5"; ctx.setLineDash([7, 5]); ctx.lineWidth = 2;
        ctx.strokeRect(b.x1 - 8, b.y1 - 8, (b.x2 - b.x1) + 16, (b.y2 - b.y1) + 16);
        ctx.restore();
      }
    }

    /* ---- 図形の当たり判定・移動（選択ツール用） ---- */
    function distToSeg(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    function bbox(s) {
      if (s.type === "pen") {
        const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y);
        return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
      }
      if (s.type === "text") {
        const fs = Math.max(18, s.width * 4);
        return { x1: s.x1, y1: s.y1, x2: s.x1 + (s.text ? s.text.length : 1) * fs * 0.6, y2: s.y1 + fs };
      }
      return { x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2), x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2) };
    }
    function hitTest(s, x, y) {
      const th = Math.max(14, s.width + 10);
      if (s.type === "arrow") return distToSeg(x, y, s.x1, s.y1, s.x2, s.y2) < th;
      if (s.type === "pen") { for (let i = 1; i < s.pts.length; i++) if (distToSeg(x, y, s.pts[i-1].x, s.pts[i-1].y, s.pts[i].x, s.pts[i].y) < th) return true; return false; }
      const b = bbox(s);
      return x >= b.x1 - th && x <= b.x2 + th && y >= b.y1 - th && y <= b.y2 + th;
    }
    function moveShape(s, dx, dy) {
      if (s.type === "pen") s.pts.forEach(p => { p.x += dx; p.y += dy; });
      else { s.x1 += dx; s.y1 += dy; if (s.x2 != null) { s.x2 += dx; s.y2 += dy; } }
    }
    function findAt(x, y) { for (let i = shapes.length - 1; i >= 0; i--) if (hitTest(shapes[i], x, y)) return shapes[i]; return null; }
    function drawShape(s) {
      ctx.lineWidth = s.width; ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (s.type === "arrow") drawArrow(s.x1, s.y1, s.x2, s.y2, s.width);
      else if (s.type === "rect") ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
      else if (s.type === "pen") {
        ctx.beginPath(); s.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
      } else if (s.type === "text") {
        ctx.font = `${Math.max(18, s.width * 4)}px sans-serif`; ctx.textBaseline = "top";
        ctx.fillText(s.text, s.x1, s.y1);
      }
    }
    function drawArrow(x1, y1, x2, y2, w) {
      const head = Math.max(12, w * 3), a = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(a - Math.PI / 6), y2 - head * Math.sin(a - Math.PI / 6));
      ctx.lineTo(x2 - head * Math.cos(a + Math.PI / 6), y2 - head * Math.sin(a + Math.PI / 6));
      ctx.closePath(); ctx.fill();
    }

    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
    }
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault(); canvas.setPointerCapture(e.pointerId);
      const p = pos(e);
      if (tool === "move") {          // 選択・移動モード
        selected = findAt(p.x, p.y);
        dragging = !!selected; last = p; redraw();
        return;
      }
      if (tool === "text") {
        const t = prompt("文字を入力"); if (t) { shapes.push({ type: "text", x1: p.x, y1: p.y, text: t, color, width }); redraw(); }
        return;
      }
      if (tool === "pen") cur = { type: "pen", pts: [p], color, width };
      else cur = { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width };
    });
    canvas.addEventListener("pointermove", (e) => {
      const p = pos(e);
      if (tool === "move") {
        if (dragging && selected) { moveShape(selected, p.x - last.x, p.y - last.y); last = p; redraw(); }
        return;
      }
      if (!cur) return;
      if (cur.type === "pen") cur.pts.push(p); else { cur.x2 = p.x; cur.y2 = p.y; }
      redraw();
    });
    const endStroke = () => { dragging = false; if (cur) { shapes.push(cur); cur = null; redraw(); } };
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);

    // ツールバー操作
    ov.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => {
      tool = b.dataset.tool;
      if (tool !== "move") { selected = null; }   // 描画モードに戻したら選択解除
      ov.querySelectorAll("[data-tool]").forEach(x => x.classList.toggle("on", x === b));
      redraw();
    });
    ov.querySelector('[data-tool="arrow"]').classList.add("on");
    ov.querySelectorAll(".anno-col").forEach(b => b.onclick = () => {
      color = b.dataset.c;
      ov.querySelectorAll(".anno-col").forEach(x => x.classList.toggle("on", x === b));
    });
    ov.querySelector(".anno-col").classList.add("on");
    ov.querySelector("#annoW").oninput = (e) => width = Number(e.target.value);
    ov.querySelector("#annoDel").onclick = () => {
      if (!selected) return;
      const i = shapes.indexOf(selected); if (i >= 0) shapes.splice(i, 1);
      selected = null; redraw();
    };
    ov.querySelector("#annoUndo").onclick = () => { shapes.pop(); if (shapes.indexOf(selected) < 0) selected = null; redraw(); };
    ov.querySelector("#annoClear").onclick = () => { shapes.length = 0; selected = null; redraw(); };
    ov.querySelector("#annoCancel").onclick = close;
    ov.querySelector("#annoSave").onclick = () => {
      const data = canvas.toDataURL("image/jpeg", 0.85);
      close();
      onSave && onSave(data);
    };
    window.addEventListener("resize", fitCanvasCss);
    function close() { window.removeEventListener("resize", fitCanvasCss); ov.remove(); }
  }

  return { open };
})();
