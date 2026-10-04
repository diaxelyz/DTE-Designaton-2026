// "Open on phone": shows the server's free https link as a QR code. Needs qrcode.js loaded first.
(function () {
  const css = `
  .nh-qr-back{position:fixed;inset:0;background:#0d1f1880;display:grid;place-items:center;z-index:50;padding:16px}
  .nh-qr{background:#fff;border-radius:24px;max-width:360px;width:100%;padding:24px;text-align:center;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#11251e;box-shadow:0 30px 80px #0006}
  .nh-qr h2{font-family:Fraunces,Georgia,serif;font-weight:600;margin:0 0 6px;font-size:1.4rem}
  .nh-qr p{margin:6px 0;color:#5f716a;font-size:.88rem;line-height:1.5}
  .nh-qr .code{display:grid;place-items:center;margin:14px auto;width:220px;height:220px}
  .nh-qr .code svg{width:220px;height:220px}
  .nh-qr .link{display:block;word-break:break-all;font-size:.8rem;color:#1f6b4f;font-weight:600;margin:6px 0 10px}
  .nh-qr ol{text-align:left;font-size:.85rem;color:#2c3f38;padding-left:20px;line-height:1.55}
  .nh-qr code{background:#e7f2ec;padding:1px 5px;border-radius:5px}
  .nh-qr button{margin-top:12px;border:0;border-radius:999px;padding:10px 22px;background:#1f6b4f;color:#fff;font:inherit;font-weight:650;cursor:pointer}
  .nh-qr .spin{width:40px;height:40px;border-radius:50%;border:4px solid #e3ebe4;border-top-color:#1f6b4f;animation:nhspin .9s linear infinite;margin:30px auto}
  @keyframes nhspin{to{transform:rotate(360deg)}}`;
  let box = null, timer = null;

  function close() { clearTimeout(timer); box?.remove(); box = null; }

  function qrSvg(url) {
    const q = qrcode(0, 'M'); q.addData(url); q.make();
    return q.createSvgTag({cellSize: 6, margin: 2, scalable: true});
  }

  async function refresh() {
    if (!box) return;
    let s = {status: 'error'};
    try { s = await (await fetch('/api/phone-link', {cache: 'no-store'})).json(); } catch {}
    const body = box.querySelector('.body');
    if (s.status === 'ready' && s.url) {
      body.innerHTML = `<div class="code">${qrSvg(s.url)}</div><a class="link" href="${s.url}" target="_blank" rel="noopener">${s.url}</a>
        <p>Scan with your phone's camera. Android: open it in Chrome. iPhone: open it in the free <strong>Bluefy</strong> app (Safari can't use Bluetooth).</p>
        <p>The helmet connects to one device at a time, so disconnect it here first. This link changes every time the server restarts.</p>`;
      return;
    }
    if (s.status === 'starting') {
      body.innerHTML = '<div class="spin"></div><p>Getting your phone link…</p>';
    } else if (s.status === 'missing') {
      body.innerHTML = `<p>One-time setup to open NeuroHalo on your phone:</p><ol>
        <li>Download <strong>cloudflared-windows-amd64.exe</strong> from Cloudflare's GitHub releases page (free).</li>
        <li>Rename it to <code>cloudflared.exe</code> and put it in the NeuroHalo folder, next to <code>server.py</code>.</li>
        <li>Stop the server (Ctrl+C) and run <code>python server.py</code> again.</li></ol>`;
      return;
    } else {
      body.innerHTML = '<p>The phone link isn\'t running. Restart the server with <code>python server.py</code> and check the laptop is online.</p>';
    }
    timer = setTimeout(refresh, 1500);
  }

  window.showPhoneQR = function () {
    if (!document.getElementById('nh-qr-css')) {
      const st = document.createElement('style'); st.id = 'nh-qr-css'; st.textContent = css; document.head.append(st);
    }
    close();
    box = document.createElement('div');
    box.className = 'nh-qr-back';
    box.innerHTML = '<div class="nh-qr" role="dialog" aria-label="Open on phone"><h2>Open on your phone</h2><div class="body"><div class="spin"></div></div><button type="button">Done</button></div>';
    box.addEventListener('click', e => { if (e.target === box || e.target.matches('button')) close(); });
    document.body.append(box);
    refresh();
  };
})();
