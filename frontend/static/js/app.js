/* ═══════════════════════════════════════════════════════════════════
   Vibe Check — app.js  (v2)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── Global state ─────────────────────────────────────────────────────────────
let currentComments   = [];
let currentClassified = [];
let activeFlagFilter      = 'all';
let activeSentimentFilter = 'all';
const STEPS = ['fetching','classifying','aggregating','insight','similar_video','comparing'];

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function getSavedData() {
  try { return JSON.parse(sessionStorage.getItem('vibeData')); } catch { return null; }
}

function showError(msg) {
  $('errorMsg').textContent = msg;
  $('errorToast').hidden = false;
}
function clearError() { $('errorToast').hidden = true; }

// ── Cold-start detection ──────────────────────────────────────────────────────
(async function checkServer() {
  const start = Date.now();
  let up = false;
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    up = r.ok;
  } catch { /* server sleeping */ }

  if (!up) {
    const banner = $('coldStartBanner');
    const bar    = $('coldBar');
    banner.hidden = false;
    const WARMUP = 35000; // ms
    const tick = setInterval(() => {
      const pct = Math.min(100, (Date.now() - start) / WARMUP * 100);
      bar.style.width = pct + '%';
      if (pct >= 100) {
        clearInterval(tick);
        banner.hidden = true;
      }
    }, 300);

    // Retry until alive
    const retry = setInterval(async () => {
      try {
        const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
        if (r.ok) { clearInterval(retry); clearInterval(tick); banner.hidden = true; }
      } catch { /* still sleeping */ }
    }, 4000);
  }
})();

// ── SPA Router ────────────────────────────────────────────────────────────────
function navigate() {
  clearError();
  const hash = window.location.hash || '#/home';
  document.querySelectorAll('.page-view').forEach(p => { p.hidden = true; });
  // Update sidebar + bottom nav active states
  document.querySelectorAll('.sidebar-link, .bottom-nav-item').forEach(l => l.classList.remove('active'));

  let pageId  = 'page-home';
  let pageKey = 'home';
  if (hash === '#/comments')      { pageId = 'page-comments';     pageKey = 'comments'; }
  if (hash === '#/similar')       { pageId = 'page-similar';      pageKey = 'similar'; }
  if (hash === '#/similar-video') { pageId = 'page-similar';      pageKey = 'similar'; }
  if (hash === '#/comparison')    { pageId = 'page-comparison';   pageKey = 'comparison'; }
  if (hash === '#/ask')           { pageId = 'page-ask-comments'; pageKey = 'ask'; }
  if (hash === '#/ask-comments')  { pageId = 'page-ask-comments'; pageKey = 'ask'; }

  const pg = $(pageId);
  if (pg) pg.hidden = false;

  // Mark active in sidebar + bottom nav by data-page attribute
  document.querySelectorAll(`[data-page="${pageKey}"]`).forEach(el => el.classList.add('active'));

  renderPage(pageId);
}
window.addEventListener('hashchange', navigate);

document.addEventListener('DOMContentLoaded', () => {
  // Sidebar toggle
  const sidebarToggle = $('sidebarToggle');
  const sidebar       = $('sidebar');
  if (sidebarToggle && sidebar) {
    sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
  }

  // Hero form wires to same submit logic as header
  const heroUrlInput   = $('heroUrlInput');
  const heroAnalyzeBtn = $('heroAnalyzeBtn');
  if (heroAnalyzeBtn && heroUrlInput) {
    heroAnalyzeBtn.addEventListener('click', () => {
      const v = heroUrlInput.value.trim();
      if (v) { $('urlInput').value = v; $('analyzeBtn').click(); }
    });
    heroUrlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { heroAnalyzeBtn.click(); }
    });
    // Sync hero input from header on focus
    heroUrlInput.addEventListener('focus', () => {
      if ($('urlInput').value) heroUrlInput.value = $('urlInput').value;
    });
  }

  // Ask-comment suggestion chips
  document.querySelectorAll('.ask-suggestion-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const qInput = $('qaInput');
      if (qInput) {
        qInput.value = btn.dataset.q;
        $('qaForm')?.dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
      }
    });
  });

  // Description box "...more" toggle
  const descMoreBtn = $('descMoreBtn');
  const descBox     = $('descBox');
  if (descMoreBtn && descBox) {
    descMoreBtn.addEventListener('click', () => {
      const collapsed = descBox.classList.toggle('collapsed');
      descMoreBtn.textContent = collapsed ? '...more' : 'Show less';
      descMoreBtn.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  // Image Credits link
  const creditsLink = $('imageCreditsLink');
  if (creditsLink) {
    creditsLink.addEventListener('click', e => {
      e.preventDefault();
      window.open('/static/img/CREDITS.txt', '_blank', 'noopener');
    });
  }

  // Player overlay → embed iframe on click
  const playerOverlayBtn = $('playerOverlayBtn');
  if (playerOverlayBtn) {
    playerOverlayBtn.addEventListener('click', () => {
      const data  = getSavedData();
      const vidId = data?.video_id;
      if (!vidId) return;
      const playerArea = $('playerArea');
      if (!playerArea || playerArea.querySelector('iframe')) return;
      const iframe = document.createElement('iframe');
      iframe.src   = `https://www.youtube-nocookie.com/embed/${vidId}?autoplay=1&rel=0`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.style.cssText   = 'position:absolute;inset:0;width:100%;height:100%;border:0;';
      playerArea.innerHTML   = '';
      playerArea.appendChild(iframe);
    });
  }

  // Load recent history from localStorage
  loadRecentHistory();

  navigate();
});

// ── Recent history ────────────────────────────────────────────────────────────
function loadRecentHistory() {
  try {
    const hist = JSON.parse(localStorage.getItem('vibeHistory') || '[]').slice(0,12);
    if (!hist.length) return;
    const section = $('recentSection');
    const grid    = $('recentGrid');
    if (!section || !grid) return;
    section.style.display = 'block';
    grid.innerHTML = '';
    hist.forEach(item => {
      const card = document.createElement('div');
      card.className = 'video-card';
      card.innerHTML = `
        <div class="vc-thumb">
          <img src="https://i.ytimg.com/vi/${item.video_id}/mqdefault.jpg" alt="${escHtml(item.title || 'Video')}" loading="lazy" width="320" height="180"/>
          <span class="vc-score-chip">${item.vibe_score ?? '?'}</span>
        </div>
        <div class="vc-info">
          <p class="vc-title">${escHtml(item.title || item.video_id)}</p>
        </div>`;
      card.addEventListener('click', () => {
        $('urlInput').value = `https://www.youtube.com/watch?v=${item.video_id}`;
        $('analyzeBtn').click();
      });
      grid.appendChild(card);
    });
  } catch { /* localStorage blocked */ }
}

function saveToHistory(data) {
  try {
    const hist = JSON.parse(localStorage.getItem('vibeHistory') || '[]');
    const entry = { video_id: data.video_id, title: data.title || '', vibe_score: data.vibe_score };
    const filtered = hist.filter(h => h.video_id !== entry.video_id);
    filtered.unshift(entry);
    localStorage.setItem('vibeHistory', JSON.stringify(filtered.slice(0,12)));
  } catch { /* ignore */ }
}



// ── Page renderers ────────────────────────────────────────────────────────────
function renderPage(pageId) {
  const data = getSavedData();
  if (data?.raw_comments)   currentComments   = data.raw_comments;
  if (data?.classified_comments) currentClassified = data.classified_comments;

  switch (pageId) {
    case 'page-home':
      if (data) populateHomeData(data);
      break;
    case 'page-comments':
      if (!data) { $('empty-comments-list').hidden = false; $('comments-list-results').hidden = true; }
      else       { $('empty-comments-list').hidden = true;  $('comments-list-results').hidden = false; renderCategorizedComments(data); }
      break;
    case 'page-similar':
      renderSimilarPage(data);
      break;
    case 'page-comparison':
      renderComparisonPage(data);
      break;
    case 'page-ask-comments':
      if (!data) { $('empty-ask-comments').hidden = false; $('ask-comments-results').hidden = true; }
      else       { $('empty-ask-comments').hidden = true;  $('ask-comments-results').hidden = false; }
      break;
  }
}

// ── Count-up animation ────────────────────────────────────────────────────────
function countUp(el, target, suffix = '%', dur = 800) {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || target === 0) { el.textContent = target + suffix; return; }
  const start = Date.now();
  const raf = () => {
    const t = Math.min(1, (Date.now() - start) / dur);
    el.textContent = Math.round(t * target) + suffix;
    if (t < 1) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}

// ── Home population ───────────────────────────────────────────────────────────
function populateHomeData(data) {
  $('home-results').hidden = false;
  // Hide How It Works when results are showing
  const hiw = $('howItWorksSection');
  if (hiw) hiw.style.display = 'none';

  // Set player thumbnail
  const vidId = data.video_id || '';
  const playerThumb = $('playerThumb');
  if (playerThumb && vidId) {
    playerThumb.src = `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`;
    playerThumb.onerror = () => { playerThumb.style.display = 'none'; };
  }

  // Video title + channel
  const vtEl = $('videoTitle');
  if (vtEl && data.title) vtEl.textContent = data.title;
  const chEl = $('channelName');
  if (chEl && data.channel_title) chEl.textContent = data.channel_title;

  // Save to history
  if (vidId) saveToHistory(data);

  // Vibe score + needle + arc fill (new gauge: pivot 70,75; arc length ~173 for 55r semicircle)
  const score = data.vibe_score || 0;
  const vibeLabel = $('vibeScoreLabel');
  if (vibeLabel) vibeLabel.textContent = '/ 100';
  const arcScore = $('arcScoreBadge');
  if (arcScore) countUp(arcScore, score, '', 800);

  const arcEl = $('arcFill');
  const ARC_LEN = 173; // π × 55
  if (arcEl) arcEl.style.strokeDashoffset = String(ARC_LEN - (score / 100) * ARC_LEN);

  const needleEl = $('arcNeedle');
  const needleAngle = -90 + (score / 100) * 180;
  if (needleEl) needleEl.style.transform = `rotate(${needleAngle}deg)`;

  // Stacked sentiment bar
  const sp = data.sentiment_percentages || {};
  const sc = data.sentiment_counts || {};
  const posW = sp.positive || 0, neuW = sp.neutral || 0, negW = sp.negative || 0;
  const barPos = $('statPos'), barNeu = $('statNeu'), barNeg = $('statNeg');
  if (barPos) barPos.style.width = posW + '%';
  if (barNeu) barNeu.style.width = neuW + '%';
  if (barNeg) barNeg.style.width = negW + '%';

  const pc = $('statPosCount'), nc = $('statNeuCount'), gc = $('statNegCount');
  if (pc) pc.textContent = posW;
  if (nc) nc.textContent = neuW;
  if (gc) gc.textContent = negW;
  const sgc = $('statGoodCount'), shc = $('statHateCount');
  if (sgc) sgc.textContent = sc.positive || 0;
  if (shc) shc.textContent = (data.flag_counts?.hate || 0);

  // Safety chips
  const fp = data.flag_percentages || {};
  const sh = $('statHate'), sg = $('statGood'), sn = $('statNone');
  if (sh) sh.textContent = (fp.hate || 0) + '% hate';
  if (sg) sg.textContent = (fp.good || 0) + '% good';
  if (sn) sn.textContent = (fp.none || 0) + '% neutral';

  // Narrative
  const narEl = $('narrativeText');
  if (narEl) narEl.textContent = data.narrative || 'Narrative not available.';

  // comments count label
  const ccLabel = $('commentsCountLabel');
  const total = data.classified_comments?.filter(c => c.status === 'success').length || 0;
  if (ccLabel) ccLabel.textContent = `${total} comments analysed`;

  // Quick comparison card (aside)
  if (data.comparison?.sentiment_comparison && data.similar_video) {
    const c  = data.comparison;
    const sv = data.similar_video;
    const qt = $('quickCompTitle');
    if (qt) qt.textContent = `vs. ${(sv.title||'Similar Video').slice(0,50)}`;

    // Upnext card (thumbnail + link)
    const svThumb = $('svThumb');
    if (svThumb && sv.video_id) {
      svThumb.src = sv.thumbnail_url || `https://i.ytimg.com/vi/${sv.video_id}/hqdefault.jpg`;
      svThumb.alt = sv.title || 'Similar video thumbnail';
    }
    const svTitleEl = $('svTitle');
    if (svTitleEl) svTitleEl.textContent = sv.title || '';
    const svChanEl = $('svChannel');
    if (svChanEl) svChanEl.textContent = sv.channel_title || '';
    const svVibe = $('svVibeScore');
    if (svVibe) svVibe.textContent = data.similar_analysis?.vibe_score ?? '—';
    const svLinkEl = $('svLink');
    if (svLinkEl && sv.video_id) svLinkEl.href = `https://www.youtube.com/watch?v=${sv.video_id}`;

    const pp  = c.sentiment_comparison?.primary || {};
    const sp2 = c.sentiment_comparison?.similar || {};
    const ids = ['qcPriPos','qcPriNeu','qcPriNeg','qcSimPos','qcSimNeu','qcSimNeg'];
    const vals = [pp.positive,pp.neutral,pp.negative,sp2.positive,sp2.neutral,sp2.negative];
    ids.forEach((id,i) => { const el=$( id); if(el) el.style.width=(vals[i]||0)+'%'; });
    const qcs = $('qcSummary');
    if (qcs) qcs.textContent = c.summary || '';
    $('quickCompCard').hidden = false;
  } else {
    $('quickCompCard').hidden = true;
  }

  // Render comments in the home page container
  renderCategorizedComments(data);
}


// ── Similar Video page ────────────────────────────────────────────────────────
function renderSimilarPage(data) {
  if (!data) {
    $('empty-similar').hidden = false; $('similar-results').hidden = true; $('similar-unavailable').hidden = true; return;
  }
  if (!data.similar_video || !data.similar_video.title) {
    $('empty-similar').hidden = true; $('similar-results').hidden = true; $('similar-unavailable').hidden = false; return;
  }
  $('empty-similar').hidden = true; $('similar-unavailable').hidden = true; $('similar-results').hidden = false;

  const sv     = data.similar_video;
  const vidId  = sv.video_id || '';
  const ytUrl  = sv.url || `https://www.youtube.com/watch?v=${vidId}`;
  const thumbUrl = sv.thumbnail_url || `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`;

  // Page-specific title/channel
  const t2 = $('svTitle2');   if (t2) t2.textContent = sv.title || '';
  const c2 = $('svChannel2'); if (c2) c2.textContent = sv.channel_title || '—';

  // Thumbnail (page)
  const thumbImg2 = $('svThumb2');
  if (thumbImg2) {
    thumbImg2.src = thumbUrl;
    thumbImg2.alt = sv.title || 'Similar video thumbnail';
    thumbImg2.onerror = () => { thumbImg2.src = `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`; };
  }

  // Watch on YouTube (page button)
  const lnk2 = $('svLink2');
  if (lnk2) lnk2.href = ytUrl;

  // thumbPlayBtn → open YouTube
  const thumbArea    = $('thumbArea');
  const thumbPlayBtn = $('thumbPlayBtn');
  if (thumbPlayBtn && vidId) {
    const fresh = thumbPlayBtn.cloneNode(true);
    thumbPlayBtn.parentNode.replaceChild(fresh, thumbPlayBtn);
    fresh.addEventListener('click', () => window.open(ytUrl, '_blank', 'noopener,noreferrer'));
  }

  // svEmbedBtn → nocookie iframe
  const embedBtn = $('svEmbedBtn');
  if (embedBtn && vidId && thumbArea) {
    const fresh2 = embedBtn.cloneNode(true);
    embedBtn.parentNode.replaceChild(fresh2, embedBtn);
    fresh2.addEventListener('click', () => {
      if (thumbArea.querySelector('iframe')) return;
      const iframe = document.createElement('iframe');
      iframe.src   = `https://www.youtube-nocookie.com/embed/${vidId}?autoplay=1&rel=0`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.style.cssText   = 'position:absolute;inset:0;width:100%;height:100%;border:0;';
      thumbArea.innerHTML    = '';
      thumbArea.appendChild(iframe);
      fresh2.hidden = true;
    });
  }

  // Stats (shared IDs used by aside AND page)
  const sa = data.similar_analysis;
  if (sa) {
    const sp2 = sa.sentiment_percentages || {};
    const fp2 = sa.flag_percentages || {};
    const sentMap = { svPos:'positive', svNeu:'neutral', svNeg:'negative' };
    const flagMap = { svHate:'hate', svGood:'good', svBad:'bad', svNone:'none' };
    Object.entries(sentMap).forEach(([id,k]) => { const el=$(id); if(el) el.textContent=(sp2[k]||0)+'%'; });
    Object.entries(flagMap).forEach(([id,k]) => { const el=$(id); if(el) el.textContent=(fp2[k]||0)+'%'; });
    const sc = $('svScore');     if (sc) sc.textContent = sv.score != null ? sv.score.toFixed(3) : '—';
    const tc = $('svTotalCount'); if (tc) tc.textContent = sa.total || 0;
    const vs = $('svVibeScore'); if (vs) vs.textContent = sa.vibe_score ?? '—';
  }
}



// ── Comparison page ───────────────────────────────────────────────────────────
function renderComparisonPage(data) {
  if (!data) {
    $('empty-comparison').hidden = false; $('comparison-results').hidden = true; $('comparison-unavailable').hidden = true; return;
  }
  const c = data.comparison;
  if (!c || !c.sentiment_comparison) {
    $('empty-comparison').hidden = true; $('comparison-results').hidden = true; $('comparison-unavailable').hidden = false; return;
  }
  $('empty-comparison').hidden = true; $('comparison-unavailable').hidden = true; $('comparison-results').hidden = false;

  const pp = c.sentiment_comparison?.primary || {};
  const sp = c.sentiment_comparison?.similar || {};

  // Stacked bars (width %)
  const el = id => $(id);
  if (el('compPriPos')) el('compPriPos').style.width = (pp.positive || 0) + '%';
  if (el('compPriNeu')) el('compPriNeu').style.width = (pp.neutral  || 0) + '%';
  if (el('compPriNeg')) el('compPriNeg').style.width = (pp.negative || 0) + '%';
  if (el('compSimPos')) el('compSimPos').style.width = (sp.positive || 0) + '%';
  if (el('compSimNeu')) el('compSimNeu').style.width = (sp.neutral  || 0) + '%';
  if (el('compSimNeg')) el('compSimNeg').style.width = (sp.negative || 0) + '%';

  // Vibe scores
  if (el('compPriVibe')) el('compPriVibe').textContent = c.vibe_comparison?.primary ?? '—';
  if (el('compSimVibe')) el('compSimVibe').textContent = c.vibe_comparison?.similar ?? '—';
  if (el('compPriSafe')) el('compPriSafe').textContent = (c.safety_comparison?.primary?.hate || 0) + '%';
  if (el('compSimSafe')) el('compSimSafe').textContent = (c.safety_comparison?.similar?.hate || 0) + '%';

  // Thumbnails
  const priId = data.video_id;
  const simId = data.similar_video?.video_id;
  const pt = $('compPriThumb'); if (pt && priId) { pt.src = `https://i.ytimg.com/vi/${priId}/mqdefault.jpg`; pt.alt = data.title || 'Primary video'; }
  const st = $('compSimThumb'); if (st && simId) { st.src = `https://i.ytimg.com/vi/${simId}/mqdefault.jpg`; st.alt = data.similar_video?.title || 'Similar video'; }

  // Titles / channels
  const pt2 = $('compPriTitle'); if (pt2 && data.title) pt2.textContent = data.title;
  const pc  = $('compPriChannel'); if (pc && data.channel_title) pc.textContent = data.channel_title;
  const st2 = $('compSimTitle'); if (st2 && data.similar_video?.title) st2.textContent = data.similar_video.title;
  const sc2 = $('compSimChannel'); if (sc2 && data.similar_video?.channel_title) sc2.textContent = data.similar_video.channel_title;

  if (el('compWinner'))     el('compWinner').textContent     = c.winner  || '—';
  if (el('compSummary'))    el('compSummary').textContent    = c.summary || '';
  if (el('compReason'))     el('compReason').textContent     = c.reason  || '';
  if (el('compStatusBadge')) el('compStatusBadge').textContent = c.status === 'partial' ? 'Deterministic fallback' : 'AI narrative';
}


// ── Agent stepper ─────────────────────────────────────────────────────────────
const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;vertical-align:middle"><path d="M3 8l3.5 3.5L13 4"/></svg>';
const SPIN_SVG  = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;vertical-align:middle;animation:pip-spin .8s linear infinite"><circle cx="8" cy="8" r="6" stroke-dasharray="25" stroke-dashoffset="10"/></svg>';

function stepperSet(step, state) {
  const el = $(`step-${step}`);
  if (!el) return;
  el.classList.remove('active', 'done');
  el.classList.add(state);
  const statusEl = el.querySelector('.pip-status');
  if (statusEl) statusEl.innerHTML = state === 'active' ? SPIN_SVG : (state === 'done' ? CHECK_SVG : '');
}
function stepperReset() {
  STEPS.forEach(s => {
    const el = $(`step-${s}`);
    if (!el) return;
    el.classList.remove('active', 'done');
    const statusEl = el.querySelector('.pip-status');
    if (statusEl) statusEl.innerHTML = '';
  });
}

// ── Analyze form ──────────────────────────────────────────────────────────────
const analyzeForm = $('analyzeForm');
const urlInput    = $('urlInput');
const analyzeBtn  = $('analyzeBtn');
const agentStepper = $('agentStepper');
const homeSkeleton = $('homeSkeleton');

let sseSource = null;

if (analyzeForm) {
  analyzeForm.addEventListener('submit', async e => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    clearError();
    analyzeBtn.classList.add('loading');
    analyzeBtn.disabled = true;

    // Sync hero input
    const heroIn = $('heroUrlInput');
    if (heroIn) heroIn.value = url;

    // Top progress bar — reset
    const topBar = $('topProgressBar');
    if (topBar) { topBar.style.width = '5%'; topBar.classList.remove('done'); topBar.style.opacity = '1'; }

    // Pipeline status text
    const pipeStatus = $('pipelineStatus');
    if (pipeStatus) { pipeStatus.hidden = false; pipeStatus.textContent = 'Starting analysis...'; }

    // Show stepper + skeleton, hide how-it-works
    agentStepper.hidden = false;
    homeSkeleton.hidden = false;
    $('home-results').hidden = true;
    $('quickCompCard').hidden = true;
    const hiw = $('howItWorksSection'); if (hiw) hiw.style.display = 'none';
    stepperReset();

    // Progress per step
    const STEP_PROGRESS = { fetching:15, classifying:35, aggregating:55, insight:70, similar_video:85, comparing:95 };
    const STEP_LABELS   = { fetching:'Fetching video data...', classifying:'Classifying comments...', aggregating:'Aggregating results...', insight:'Generating AI insight...', similar_video:'Finding similar video...', comparing:'Comparing videos...' };

    // Open SSE for live step updates
    if (sseSource) sseSource.close();
    const encoded = encodeURIComponent(url);
    sseSource = new EventSource(`/api/analyze/stream?url=${encoded}`);
    const doneSteps = new Set();
    sseSource.onmessage = evt => {
      const d = JSON.parse(evt.data);
      const step = d.step;
      if (!step || step === 'done') { sseSource.close(); return; }
      // Update top bar and status text
      if (topBar && STEP_PROGRESS[step]) topBar.style.width = STEP_PROGRESS[step] + '%';
      if (pipeStatus && STEP_LABELS[step]) pipeStatus.textContent = STEP_LABELS[step];
      // Mark previous steps done
      STEPS.forEach(s => {
        if (s !== step && !doneSteps.has(s)) {
          const idx = STEPS.indexOf(s);
          const cur  = STEPS.indexOf(step);
          if (idx < cur) { stepperSet(s, 'done'); doneSteps.add(s); }
        }
      });
      stepperSet(step, 'active');
    };
    sseSource.onerror = () => sseSource.close();


    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Analysis failed');
      }

      const data = await res.json();

      // Mark all steps done
      STEPS.forEach(s => stepperSet(s, 'done'));

      // Complete top bar and hide status text
      if (topBar) { topBar.style.width = '100%'; setTimeout(() => topBar.classList.add('done'), 400); }
      if (pipeStatus) { pipeStatus.hidden = true; pipeStatus.textContent = ''; }

      sessionStorage.setItem('vibeData', JSON.stringify(data));
      currentComments   = data.raw_comments || [];
      currentClassified = data.classified_comments || [];

      homeSkeleton.hidden = true;

      if (window.location.hash !== '#/home' && window.location.hash !== '') {
        window.location.hash = '#/home';
      } else {
        populateHomeData(data);
      }

    } catch (err) {
      homeSkeleton.hidden = true;
      agentStepper.hidden = true;

      // Classify the error for a helpful message
      const msg = err.message || '';
      let userMsg;
      if (err.name === 'AbortError' || msg.toLowerCase().includes('abort')) {
        userMsg = 'Analysis cancelled.';
      } else if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out') || msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('networkerror')) {
        userMsg = 'Server took too long to respond. It may be waking up — try again in 30 seconds.';
      } else if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
        userMsg = 'Rate limit reached. Please wait a moment and try again.';
      } else if (msg.includes('Analysis failed') || msg.includes('detail')) {
        userMsg = msg;
      } else if (msg.toLowerCase().includes('json') || msg.toLowerCase().includes('unexpected token')) {
        userMsg = 'Unexpected server response. Please try again.';
      } else {
        userMsg = msg || 'Analysis failed. Please try again.';
      }
      showError(userMsg);
    } finally {
      analyzeBtn.classList.remove('loading');
      analyzeBtn.disabled = false;
      if (sseSource) { sseSource.close(); sseSource = null; }
    }
  });
}

// ── Q&A form ──────────────────────────────────────────────────────────────────
const qaForm       = $('qaForm');
const qaInput      = $('qaInput');
const qaBtn        = $('qaBtn');
const qaAnswerWrap = $('qaAnswerWrap');
const qaAnswerText = $('qaAnswerText');

if (qaForm) {
  qaForm.addEventListener('submit', async e => {
    e.preventDefault();
    const q = qaInput.value.trim();
    if (!q) return;
    clearError();
    qaBtn.classList.add('loading');
    qaAnswerWrap.hidden = true;

    try {
      const res = await fetch('/api/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, comments: currentComments })
      });
      if (!res.ok) throw new Error('Q&A request failed');
      const d = await res.json();
      qaAnswerText.textContent = d.answer;
      qaAnswerWrap.hidden = false;
    } catch (err) {
      showError(err.message || 'Q&A failed.');
    } finally {
      qaBtn.classList.remove('loading');
    }
  });
}

// ── Comment filter buttons ────────────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    activeFlagFilter = e.currentTarget.dataset.flag;
    renderCategorizedComments(getSavedData(), false);
  });
});

document.querySelectorAll('.filter-sentiment-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    document.querySelectorAll('.filter-sentiment-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    activeSentimentFilter = e.currentTarget.dataset.sentiment;
    renderCategorizedComments(getSavedData(), false);
  });
});

// ── Categorized comments renderer ─────────────────────────────────────────────
const FLAG_LABELS = { hate: 'Hate', good: 'Good', bad: 'Spam', none: 'Neutral' };
const FLAG_ACCENT = { hate: 'accent-hate', good: 'accent-good', bad: 'accent-bad', none: 'accent-none' };
const SENT_BADGE  = { positive: 'badge-sent-pos', neutral: 'badge-sent-neu', negative: 'badge-sent-neg' };
const FLAG_BADGE  = { hate: 'badge-flag-hate', good: 'badge-flag-good', bad: 'badge-flag-bad', none: 'badge-flag-none' };

function renderCategorizedComments(data, updateCounts = true) {
  if (!data || !data.classified_comments) return;
  const comments = data.classified_comments;

  if (updateCounts) {
    const fc = data.flag_counts || {};
    const cAll  = $('count-all');
    const cHate = $('count-hate');
    const cGood = $('count-good');
    const cNone = $('count-none');
    if (cAll)  cAll.textContent  = comments.filter(c => c.status === 'success').length;
    if (cHate) cHate.textContent = fc.hate || 0;
    if (cGood) cGood.textContent = fc.good || 0;
    if (cNone) cNone.textContent = fc.none || 0;
  }

  const container = $('categorized-comments-container');
  if (!container) return;

  const filtered = comments.filter(c => {
    if (c.status !== 'success') return false;
    const mFlag = activeFlagFilter     === 'all' || c.flag      === activeFlagFilter;
    const mSent = activeSentimentFilter === 'all' || c.sentiment === activeSentimentFilter;
    return mFlag && mSent;
  });

  container.innerHTML = '';

  // Section heading
  const SECTION_LABELS = {
    all:  'All Comments', hate: 'Hateful Comments',
    good: 'Good Comments', bad: 'Spam / Low Quality', none: 'Neutral / Other',
  };
  const heading = document.createElement('div');
  heading.className = 'cat-section';
  const h3 = document.createElement('h3');
  h3.className = 'cat-heading';
  const dot = document.createElement('span');
  dot.className = 'cat-dot';
  dot.style.background = {
    all:'#9CA3AF', hate:'#B42318', good:'#2F9E6E', bad:'#F59E0B', none:'#8A94A6'
  }[activeFlagFilter] || '#9CA3AF';
  h3.appendChild(dot);
  h3.appendChild(document.createTextNode(SECTION_LABELS[activeFlagFilter] || 'Comments'));
  heading.appendChild(h3);
  container.appendChild(heading);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = activeFlagFilter === 'hate'
      ? 'No hateful comments detected — great sign!'
      : 'No comments match the selected filters.';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'comment-list';

  filtered.forEach((c, idx) => {
    const flagKey = c.flag      || 'none';
    const sentKey = c.sentiment || 'neutral';

    // Card
    const card = document.createElement('div');
    card.className = 'comment-item';

    // Accent bar
    const accent = document.createElement('div');
    accent.className = `comment-accent ${FLAG_ACCENT[flagKey] || 'accent-none'}`;
    card.appendChild(accent);

    // Body
    const body = document.createElement('div');
    body.className = 'comment-body';

    // Text (XSS-safe: textContent only)
    const txt = document.createElement('p');
    txt.className = 'comment-text';
    txt.textContent = c.text || '';
    body.appendChild(txt);

    // Badges
    const badges = document.createElement('div');
    badges.className = 'comment-badges';

    const sentBadge = document.createElement('span');
    sentBadge.className = `badge ${SENT_BADGE[sentKey] || 'badge-sent-neu'}`;
    sentBadge.textContent = sentKey.charAt(0).toUpperCase() + sentKey.slice(1);
    badges.appendChild(sentBadge);

    const flagBadge = document.createElement('span');
    flagBadge.className = `badge ${FLAG_BADGE[flagKey] || 'badge-flag-none'}`;
    flagBadge.textContent = FLAG_LABELS[flagKey] || flagKey;
    badges.appendChild(flagBadge);

    if (c.mixed) {
      const mixBadge = document.createElement('span');
      mixBadge.className = 'badge badge-sent-neu';
      mixBadge.textContent = 'Mixed';
      badges.appendChild(mixBadge);
    }
    body.appendChild(badges);

    // Classification detail toggle (confidence, reason) — no HTML injection
    if (c.reason || c.confidence) {
      const toggle = document.createElement('button');
      toggle.className = 'cat-comment-details-toggle';
      toggle.style.cssText = 'background:none;border:none;font-size:11px;color:var(--txt-m);cursor:pointer;padding:4px 0;text-align:left;';
      toggle.textContent = 'View details';
      const detail = document.createElement('div');
      detail.hidden = true;
      detail.style.cssText = 'font-size:11px;color:var(--txt-2);margin-top:4px;line-height:1.5;';
      if (c.confidence) {
        const cp = document.createElement('p');
        cp.textContent = `Confidence: ${c.confidence}`;
        detail.appendChild(cp);
      }
      if (c.reason) {
        const rp = document.createElement('p');
        rp.textContent = `Reason: ${c.reason}`;
        detail.appendChild(rp);
      }
      toggle.addEventListener('click', () => { detail.hidden = !detail.hidden; });
      body.appendChild(toggle);
      body.appendChild(detail);
    }

    card.appendChild(body);
    list.appendChild(card);
  });

  container.appendChild(list);
}


function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
