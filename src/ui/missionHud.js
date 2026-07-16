const CY = '#7eb8d4';
const GR = '#7ee8b0';
const AM = '#ffcf6a';
const RD = '#ff7a68';

function fmtTime(value) {
  const total = Math.max(0, Math.ceil(Number(value) || 0));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export class MissionHUD {
  constructor() {
    this.root = document.createElement('div');
    this.root.setAttribute('data-ui', '');
    this.root.style.cssText = 'position:fixed;inset:0;z-index:62;pointer-events:none;font-family:"Courier New",monospace;color:#fff;text-shadow:0 1px 4px #000;';

    this.panel = document.createElement('div');
    this.panel.style.cssText = 'position:fixed;top:max(12px,env(safe-area-inset-top));left:max(12px,env(safe-area-inset-left));width:min(58vw,340px);padding:10px 12px;border:1px solid rgba(126,184,212,.38);border-radius:9px;background:rgba(5,12,22,.78);backdrop-filter:blur(7px);';
    this.root.appendChild(this.panel);

    this.notice = document.createElement('div');
    this.notice.style.cssText = 'position:fixed;top:108px;left:50%;transform:translateX(-50%);max-width:min(84vw,480px);padding:9px 13px;border:1px solid rgba(126,184,212,.45);border-radius:8px;background:rgba(5,12,22,.88);text-align:center;font-size:11px;line-height:1.45;opacity:0;transition:opacity .18s;';
    this.root.appendChild(this.notice);
    this.noticeUntil = 0;

    this.briefing = document.createElement('div');
    this.briefing.setAttribute('data-ui', '');
    this.briefing.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:20px;pointer-events:auto;background:rgba(2,7,13,.72);backdrop-filter:blur(6px);';
    this.root.appendChild(this.briefing);

    document.body.appendChild(this.root);
  }

  showBriefing(level, onStart) {
    this.panel.style.display = 'none';
    this.briefing.innerHTML = `
      <div style="width:min(88vw,520px);padding:22px;border:1px solid rgba(126,184,212,.48);border-radius:12px;background:rgba(5,12,22,.94);box-shadow:0 12px 40px rgba(0,0,0,.45)">
        <div style="font-size:12px;letter-spacing:.18em;color:${CY}">LEVEL 1</div>
        <div style="font-size:26px;font-weight:bold;margin-top:5px">${level.title}</div>
        <div style="font-size:13px;line-height:1.55;margin-top:12px;color:#dbe7ed">${level.subtitle}</div>
        <div style="margin-top:15px;padding:11px;border-left:3px solid ${AM};background:rgba(255,207,106,.08);font-size:12px;line-height:1.55">
          Het schip ligt voor anker. Sleep links op het scherm om het inslagpunt te corrigeren. Wacht tot het geschut gereed is en gebruik de rode vuurknop.
        </div>
        <button data-start style="width:100%;min-height:58px;margin-top:18px;border:1px solid rgba(126,232,176,.65);border-radius:10px;background:rgba(30,120,78,.82);color:#fff;font:bold 14px 'Courier New',monospace;letter-spacing:.08em;touch-action:none">START MISSIE</button>
      </div>`;
    this.briefing.style.display = 'flex';
    const button = this.briefing.querySelector('[data-start]');
    let pointer = null;
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault(); pointer = e.pointerId;
      try { button.setPointerCapture(e.pointerId); } catch (_) {}
      button.style.transform = 'scale(.97)';
    });
    button.addEventListener('pointerup', (e) => {
      if (e.pointerId !== pointer) return;
      e.preventDefault(); pointer = null; button.style.transform = '';
      this.briefing.style.display = 'none';
      this.panel.style.display = '';
      if (typeof onStart === 'function') onStart();
    });
    button.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== pointer) return;
      pointer = null; button.style.transform = '';
    });
  }

  announce(title, detail = '', kind = 'info', duration = 3.5) {
    const color = kind === 'success' ? GR : kind === 'danger' ? RD : kind === 'warning' ? AM : CY;
    this.notice.innerHTML = `<div style="font-weight:bold;letter-spacing:.1em;color:${color}">${title}</div>${detail ? `<div style="margin-top:3px;color:#eef5f8">${detail}</div>` : ''}`;
    this.notice.style.borderColor = color;
    this.notice.style.opacity = '1';
    this.noticeUntil = performance.now() + duration * 1000;
  }

  update(snapshot) {
    if (!snapshot) return;
    if (this.noticeUntil && performance.now() >= this.noticeUntil) {
      this.notice.style.opacity = '0';
      this.noticeUntil = 0;
    }
    const current = snapshot.objectiveIndex + 1;
    const total = snapshot.objectiveTotal;
    const progress = Math.max(0, Math.min(total, snapshot.completedCount));
    const blocks = Array.from({ length: total }, (_, i) => i < progress ? '■' : '□').join('');
    const timerColor = snapshot.timeRemaining <= 20 ? RD : snapshot.timeRemaining <= 40 ? AM : '#fff';
    this.panel.innerHTML = `
      <div style="font-size:9px;letter-spacing:.16em;color:${CY}">VUURMISSIE ${current}/${total}</div>
      <div style="font-size:14px;font-weight:bold;margin-top:3px">${snapshot.targetLabel || 'WACHTEN OP DOEL'}</div>
      <div style="font-size:10px;line-height:1.45;color:#dbe7ed;margin-top:4px">${snapshot.orderText || ''}</div>
      <div style="display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:10px">
        <span style="color:${AM}">${snapshot.phaseLabel || ''}</span>
        <span style="color:${timerColor}">${fmtTime(snapshot.timeRemaining)}</span>
      </div>
      <div style="margin-top:5px;font-size:11px;letter-spacing:.12em;color:${GR}">${blocks}</div>`;
  }

  reset() {
    this.notice.style.opacity = '0';
    this.noticeUntil = 0;
  }

  dispose() {
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }
}
