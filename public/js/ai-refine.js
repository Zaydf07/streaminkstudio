/* AI Refine — floating panel for contenteditable editors */
(function () {
  const BAR_HTML = `
<div id="ai-refine-bar" style="position:fixed;display:none;z-index:9999;background:#1e1e2e;border-radius:14px;overflow:hidden;width:300px;box-shadow:0 16px 48px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08)">
  <div style="padding:12px 14px 10px;border-bottom:1px solid rgba(255,255,255,.07)">
    <div style="font-size:10px;font-weight:800;color:#a5b4fc;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">✨ AI Refine</div>
    <div id="air-preview" style="font-size:11px;color:#94a3b8;max-height:38px;overflow:hidden;line-height:1.5;font-style:italic"></div>
  </div>
  <div style="padding:12px 14px">
    <input id="air-input" placeholder="e.g. Make it shorter, more persuasive…" autocomplete="off"
      style="width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);border-radius:8px;padding:8px 11px;font-size:12px;color:#f1f5f9;font-family:inherit;outline:none;transition:.2s">
    <div style="display:flex;gap:7px;margin-top:9px">
      <button id="air-apply" style="flex:1;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;border:none;padding:9px;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;transition:.2s">Refine →</button>
      <button id="air-close" style="background:rgba(255,255,255,.08);color:#94a3b8;border:none;padding:9px 13px;border-radius:8px;cursor:pointer;font-size:13px;line-height:1;transition:.2s">✕</button>
    </div>
  </div>
</div>`;

  document.body.insertAdjacentHTML('beforeend', BAR_HTML);

  const bar   = document.getElementById('ai-refine-bar');
  const inp   = document.getElementById('air-input');
  const prv   = document.getElementById('air-preview');
  const apply = document.getElementById('air-apply');
  const close = document.getElementById('air-close');
  let saved   = null;

  /* Show bar when user selects text inside a contenteditable */
  document.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const range = sel.getRangeAt(0);
    const node  = range.commonAncestorContainer;
    const el    = node.nodeType === 3 ? node.parentElement : node;
    if (!el.closest('[contenteditable]')) return;

    saved = range.cloneRange();
    const txt = sel.toString();
    prv.textContent = txt.length > 110 ? txt.slice(0, 110) + '…' : txt;

    const rect = range.getBoundingClientRect();
    bar.style.display = 'block';
    bar.style.left = Math.min(rect.left, window.innerWidth - 316) + 'px';
    bar.style.top  = (rect.bottom + window.scrollY + 10) + 'px';
    setTimeout(() => inp.focus(), 60);
  });

  close.onclick = () => { bar.style.display = 'none'; saved = null; inp.value = ''; };

  document.addEventListener('mousedown', e => {
    if (!bar.contains(e.target)) bar.style.display = 'none';
  });

  inp.addEventListener('keydown', e => { if (e.key === 'Enter') apply.click(); });

  apply.onclick = async () => {
    if (!saved || !inp.value.trim()) return;
    apply.textContent = 'Refining…';
    apply.disabled = true;
    try {
      const r = await fetch('/api/refine', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: saved.toString(), instruction: inp.value.trim() }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (d.refined) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(saved);
        document.execCommand('insertText', false, d.refined);
      }
    } catch (e) {
      alert('AI Refine failed: ' + e.message);
    }
    apply.textContent = 'Refine →';
    apply.disabled = false;
    bar.style.display = 'none';
    saved = null;
    inp.value = '';
  };
})();
