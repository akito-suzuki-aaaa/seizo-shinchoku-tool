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
    let tool = "arrow";
    let color = "#e53935";
    let width = 6;

    const ov = document.createElement("div");
    ov.className = "anno";
    ov.innerHTML = `
      <div class="anno-bar anno-top">
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
    }
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
      if (tool === "text") {
        const t = prompt("文字を入力"); if (t) { shapes.push({ type: "text", x1: p.x, y1: p.y, text: t, color, width }); redraw(); }
        return;
      }
      if (tool === "pen") cur = { type: "pen", pts: [p], color, width };
      else cur = { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!cur) return; const p = pos(e);
      if (cur.type === "pen") cur.pts.push(p); else { cur.x2 = p.x; cur.y2 = p.y; }
      redraw();
    });
    const endStroke = () => { if (cur) { shapes.push(cur); cur = null; redraw(); } };
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);

    // ツールバー操作
    ov.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => {
      tool = b.dataset.tool;
      ov.querySelectorAll("[data-tool]").forEach(x => x.classList.toggle("on", x === b));
    });
    ov.querySelector('[data-tool="arrow"]').classList.add("on");
    ov.querySelectorAll(".anno-col").forEach(b => b.onclick = () => {
      color = b.dataset.c;
      ov.querySelectorAll(".anno-col").forEach(x => x.classList.toggle("on", x === b));
    });
    ov.querySelector(".anno-col").classList.add("on");
    ov.querySelector("#annoW").oninput = (e) => width = Number(e.target.value);
    ov.querySelector("#annoUndo").onclick = () => { shapes.pop(); redraw(); };
    ov.querySelector("#annoClear").onclick = () => { shapes.length = 0; redraw(); };
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
