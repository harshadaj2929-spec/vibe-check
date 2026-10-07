// Router & State Management
function navigate() {
  const hash = window.location.hash || '#/home';
  document.querySelectorAll('.page-view').forEach(p => p.hidden = true);
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  
  let pageId = 'page-home';
  if (hash === '#/similar-video') pageId = 'page-similar';
  if (hash === '#/comparison') pageId = 'page-comparison';
  if (hash === '#/comments') pageId = 'page-comments';
  if (hash === '#/ask-comments') pageId = 'page-ask-comments';

  document.getElementById(pageId).hidden = false;
  const activeLink = document.querySelector(`.nav-link[href="${hash}"]`);
  if (activeLink) activeLink.classList.add('active');

  renderStateForPage(pageId);
}

window.addEventListener('hashchange', navigate);
document.addEventListener('DOMContentLoaded', navigate);

function getSavedData() {
  const d = sessionStorage.getItem('vibeData');
  return d ? JSON.parse(d) : null;
}

let currentComments = [];
let currentClassified = [];
let activeFlagFilter = 'all';
let activeSentimentFilter = 'all';

function renderStateForPage(pageId) {
  const data = getSavedData();
  
  if (data && data.raw_comments) {
    currentComments = data.raw_comments;
  }
  
  if (pageId === 'page-similar') {
    if (!data) {
      document.getElementById('empty-similar').hidden = false;
      document.getElementById('similar-results').hidden = true;
      document.getElementById('similar-unavailable').hidden = true;
    } else if (!data.similar_video || !data.similar_video.title || data.similar_video.error) {
      document.getElementById('empty-similar').hidden = true;
      document.getElementById('similar-results').hidden = true;
      document.getElementById('similar-unavailable').hidden = false;
    } else {
      document.getElementById('empty-similar').hidden = true;
      document.getElementById('similar-unavailable').hidden = true;
      document.getElementById('similar-results').hidden = false;
      
      document.getElementById('svTitle').textContent = data.similar_video.title;
      document.getElementById('svChannel').textContent = data.similar_video.channel_title || '-';
      document.getElementById('svScore').textContent = data.similar_video.score ? data.similar_video.score.toFixed(3) : '-';
      
      const s = data.similar_analysis;
      if (s) {
        document.getElementById('svPos').textContent = s.sentiment_percentages?.positive ?? '-';
        document.getElementById('svNeu').textContent = s.sentiment_percentages?.neutral ?? '-';
        document.getElementById('svNeg').textContent = s.sentiment_percentages?.negative ?? '-';
        document.getElementById('svHate').textContent = s.flag_percentages?.hate ?? '-';
        document.getElementById('svGood').textContent = s.flag_percentages?.good ?? '-';
        document.getElementById('svBad').textContent = s.flag_percentages?.bad ?? '-';
        document.getElementById('svNone').textContent = s.flag_percentages?.none ?? '-';
        document.getElementById('svVibeScore').textContent = s.vibe_score ?? '-';
        document.getElementById('svTotalCount').textContent = s.total ?? 0;
      }
    }
  }
  
  if (pageId === 'page-comparison') {
    if (!data) {
      document.getElementById('empty-comparison').hidden = false;
      document.getElementById('comparison-results').hidden = true;
      document.getElementById('comparison-unavailable').hidden = true;
    } else if (!data.comparison || data.comparison.status === 'error' || !data.comparison.sentiment_comparison) {
      document.getElementById('empty-comparison').hidden = true;
      document.getElementById('comparison-results').hidden = true;
      document.getElementById('comparison-unavailable').hidden = false;
    } else {
      document.getElementById('empty-comparison').hidden = true;
      document.getElementById('comparison-unavailable').hidden = true;
      document.getElementById('comparison-results').hidden = false;
      
      const c = data.comparison;
      document.getElementById('compPriPos').textContent = c.sentiment_comparison?.primary?.positive + '%' || '-';
      document.getElementById('compPriNeg').textContent = c.sentiment_comparison?.primary?.negative + '%' || '-';
      document.getElementById('compPriNeu').textContent = c.sentiment_comparison?.primary?.neutral + '%' || '-';
      document.getElementById('compPriVibe').textContent = c.vibe_comparison?.primary ?? '-';
      document.getElementById('compPriSafe').textContent = c.safety_comparison?.primary?.hate + '%' || '-';
      
      document.getElementById('compSimPos').textContent = c.sentiment_comparison?.similar?.positive + '%' || '-';
      document.getElementById('compSimNeg').textContent = c.sentiment_comparison?.similar?.negative + '%' || '-';
      document.getElementById('compSimNeu').textContent = c.sentiment_comparison?.similar?.neutral + '%' || '-';
      document.getElementById('compSimVibe').textContent = c.vibe_comparison?.similar ?? '-';
      document.getElementById('compSimSafe').textContent = c.safety_comparison?.similar?.hate + '%' || '-';
      
      document.getElementById('compWinner').textContent = c.winner || '-';
      document.getElementById('compSummary').textContent = c.summary || '';
      document.getElementById('compReason').textContent = c.reason || '';
    }
  }
  
  if (pageId === 'page-comments') {
    if (!data) {
      document.getElementById('empty-comments-list').hidden = false;
      document.getElementById('comments-list-results').hidden = true;
    } else {
      document.getElementById('empty-comments-list').hidden = true;
      document.getElementById('comments-list-results').hidden = false;
      renderCategorizedComments(data);
    }
  }

  if (pageId === 'page-ask-comments') {
    if (!data) {
      document.getElementById('empty-ask-comments').hidden = false;
      document.getElementById('ask-comments-results').hidden = true;
    } else {
      document.getElementById('empty-ask-comments').hidden = true;
      document.getElementById('ask-comments-results').hidden = false;
    }
  }
  
  if (pageId === 'page-home') {
    if (data) {
      populateHomeData(data);
    }
  }
}

// Helpers
const analyzeForm = document.getElementById('analyzeForm');
const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const agentStatus = document.getElementById('agentStatus');
const agentMsg = document.getElementById('agentMsg');
const errorToast = document.getElementById('errorToast');
const errorMsg = document.getElementById('errorMsg');

const qaForm = document.getElementById('qaForm');
const qaInput = document.getElementById('qaInput');
const qaBtn = document.getElementById('qaBtn');
const qaAnswerWrap = document.getElementById('qaAnswerWrap');
const qaAnswerText = document.getElementById('qaAnswerText');

function showError(msg) {
  if(errorMsg) errorMsg.textContent = msg;
  if(errorToast) errorToast.hidden = false;
}

function clearError() {
  if(errorToast) errorToast.hidden = true;
}

function populateHomeData(data) {
  const homeResults = document.getElementById('home-results');
  if(homeResults) homeResults.hidden = false;
  
  // Vibe score
  const score = data.vibe_score || 0;
  document.getElementById('vibeScoreLabel').textContent = score;
  const needleAngle = (score / 100) * 180;
  document.getElementById('arcNeedle').setAttribute('transform', `rotate(${needleAngle}, 130, 130)`);
  document.getElementById('arcScoreBadge').textContent = score;
  
  // Equaliser
  const eqContainer = document.getElementById('eqContainer');
  eqContainer.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const bar = document.createElement('div');
    bar.className = 'eq-bar';
    const height = 20 + Math.random() * 60;
    bar.style.height = height + '%';
    const t = i / 19;
    const r = Math.round(255 + t * (0 - 255));
    const g = Math.round(77 + t * (230 - 77));
    const b = Math.round(77 + t * (118 - 77));
    bar.style.backgroundColor = `rgb(${r},${g},${b})`;
    bar.style.animationDelay = (Math.random() * 0.5) + 's';
    eqContainer.appendChild(bar);
  }
  
  // Sentiment
  const sp = data.sentiment_percentages || {};
  const sc = data.sentiment_counts || {};
  document.getElementById('statPos').textContent = (sp.positive || 0) + '%';
  document.getElementById('statNeu').textContent = (sp.neutral || 0) + '%';
  document.getElementById('statNeg').textContent = (sp.negative || 0) + '%';
  document.getElementById('statPosCount').textContent = (sc.positive || 0) + ' comments';
  document.getElementById('statNeuCount').textContent = (sc.neutral || 0) + ' comments';
  document.getElementById('statNegCount').textContent = (sc.negative || 0) + ' comments';
  
  // Content Safety
  const fp = data.flag_percentages || {};
  const fc = data.flag_counts || {};
  document.getElementById('statHate').textContent = (fp.hate || 0) + '%';
  document.getElementById('statGood').textContent = (fp.good || 0) + '%';
  document.getElementById('statBad').textContent = (fp.bad || 0) + '%';
  document.getElementById('statNone').textContent = (fp.none || 0) + '%';
  document.getElementById('statHateCount').textContent = (fc.hate || 0) + ' comments';
  document.getElementById('statGoodCount').textContent = (fc.good || 0) + ' comments';
  document.getElementById('statBadCount').textContent = (fc.bad || 0) + ' comments';
  document.getElementById('statNoneCount').textContent = (fc.none || 0) + ' comments';
  
  // Narrative
  document.getElementById('narrativeText').textContent = data.insight?.narrative || "Narrative not available.";
  
  // Top Comments
  const tc = data.top_comments || {};
  function fillCol(id, arr) {
    const el = document.getElementById(id);
    if(!el) return;
    el.innerHTML = '';
    (arr || []).forEach(c => {
      const d = document.createElement('div');
      d.className = 'comment-card';
      d.textContent = c;
      el.appendChild(d);
    });
  }
  fillCol('topPos', tc.positive);
  fillCol('topNeu', tc.neutral);
  fillCol('topNeg', tc.negative);
}

if(analyzeForm) {
  analyzeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    
    clearError();
    analyzeBtn.classList.add('loading');
    agentStatus.hidden = false;
    agentMsg.textContent = 'Multi-agent analysis running...';
    
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url: url })
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Analysis failed');
      }
      
      const data = await res.json();
      sessionStorage.setItem('vibeData', JSON.stringify(data));
      currentComments = data.raw_comments || [];
      
      // Auto-navigate to home if elsewhere
      if(window.location.hash !== '#/home' && window.location.hash !== '') {
        window.location.hash = '#/home';
      } else {
        populateHomeData(data);
      }
      
    } catch (err) {
      showError(err.message || 'Something went wrong.');
    } finally {
      analyzeBtn.classList.remove('loading');
      agentStatus.hidden = true;
    }
  });
}

if(qaForm) {
  qaForm.addEventListener('submit', async (e) => {
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
      
      if (!res.ok) throw new Error('Q&A failed');
      
      const data = await res.json();
      qaAnswerText.textContent = data.answer;
      qaAnswerWrap.hidden = false;
    } catch (err) {
      showError(err.message || 'Something went wrong.');
    } finally {
      qaBtn.classList.remove('loading');
    }
  });
}


// --- Comments Filter Logic ---
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    activeFlagFilter = e.target.dataset.flag;
    renderCategorizedComments(getSavedData(), false);
  });
});

document.querySelectorAll('.filter-sentiment-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.filter-sentiment-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    activeSentimentFilter = e.target.dataset.sentiment;
    renderCategorizedComments(getSavedData(), false);
  });
});

function renderCategorizedComments(data, updateCounts = true) {
  if (!data || !data.classified_comments) return;
  const comments = data.classified_comments;
  
  if (updateCounts) {
    const fCounts = data.flag_counts || {};
    document.getElementById('count-all').textContent = comments.length;
    document.getElementById('count-hate').textContent = fCounts.hate || 0;
    document.getElementById('count-good').textContent = fCounts.good || 0;
    document.getElementById('count-bad').textContent = fCounts.bad || 0;
    document.getElementById('count-none').textContent = fCounts.none || 0;
  }
  
  const container = document.getElementById('categorized-comments-container');
  const filtered = comments.filter(c => {
    if (c.status !== 'success') return false;
    const matchFlag = activeFlagFilter === 'all' || c.flag === activeFlagFilter;
    const matchSentiment = activeSentimentFilter === 'all' || c.sentiment === activeSentimentFilter;
    return matchFlag && matchSentiment;
  });
  

  let headerHtml = '';
  if (activeFlagFilter === 'all') {
    headerHtml = '<div style="margin-bottom:1.5rem;"><h3>ALL COMMENTS</h3><p style="color:var(--muted); font-size:0.9rem;">All comments successfully classified by the Vibe Check Deep Classifier.</p></div>';
  }
  if (activeFlagFilter === 'hate') {
    headerHtml = '<div style="margin-bottom:1.5rem;"><h3 style="color:var(--neg);">🔴 HATED COMMENTS</h3><p style="color:var(--muted); font-size:0.9rem;">Comments containing targeted harassment, abusive attacks, threats, slurs, or other hateful content.</p></div>';
  } else if (activeFlagFilter === 'good') {
    headerHtml = '<div style="margin-bottom:1.5rem;"><h3 style="color:var(--pos);">🟢 GOOD COMMENTS</h3><p style="color:var(--muted); font-size:0.9rem;">Meaningful praise, constructive criticism, useful discussion, and substantive feedback.</p></div>';
  } else if (activeFlagFilter === 'bad') {
    headerHtml = '<div style="margin-bottom:1.5rem;"><h3 style="color:orange;">🟠 BAD COMMENTS</h3><p style="color:var(--muted); font-size:0.9rem;">Low-quality, spam, promotional, or irrelevant content.</p></div>';
  } else if (activeFlagFilter === 'none') {
    headerHtml = '<div style="margin-bottom:1.5rem;"><h3>⚪ NEUTRAL / OTHER COMMENTS</h3><p style="color:var(--muted); font-size:0.9rem;">Standard comments that do not trigger safety flags.</p></div>';
  }

  if (filtered.length === 0) {
    let emptyMsg = "No comments match the selected filters.";
    if (activeFlagFilter === 'hate' && activeSentimentFilter === 'all') emptyMsg = "No hateful comments detected.";
    container.innerHTML = headerHtml + '<div class="empty-category">' + emptyMsg + '</div>';
    return;
  }
  
  container.innerHTML = headerHtml;

  
  const flagIcons = { hate: '🔴', good: '🟢', bad: '🟠', none: '⚪' };
  
  filtered.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'cat-comment-card';
    
    const flagStr = c.flag ? c.flag.charAt(0).toUpperCase() + c.flag.slice(1) : 'None';
    const sentStr = c.sentiment ? c.sentiment.charAt(0).toUpperCase() + c.sentiment.slice(1) : 'Neutral';
    const icon = flagIcons[c.flag] || '⚪';
    
    let htmlStr = '<div class="cat-comment-text">"' + c.text + '"</div>';
    htmlStr += '<div class="cat-comment-meta">';
    htmlStr += '<span>Sentiment: ' + sentStr + '</span>';
    htmlStr += '<span>Content: ' + icon + ' ' + flagStr + '</span>';
    htmlStr += '</div>';
    
    if (c.mixed || c.evidence || c.reason) {
      htmlStr += '<button class="cat-comment-details-toggle" onclick="document.getElementById(\'details-' + idx + '\').hidden = !document.getElementById(\'details-' + idx + '\').hidden">View classification details</button>';
      htmlStr += '<div class="cat-comment-details" id="details-' + idx + '" hidden>';
      if (c.mixed !== undefined) htmlStr += '<p><strong>Mixed:</strong> ' + (c.mixed ? 'Yes' : 'No') + '</p>';
      if (c.confidence) htmlStr += '<p><strong>Confidence:</strong> ' + c.confidence + '</p>';
      if (c.evidence && c.evidence.length) htmlStr += '<p><strong>Evidence:</strong> ' + c.evidence.join(' ') + '</p>';
      if (c.reason) htmlStr += '<p><strong>Reason:</strong> ' + c.reason + '</p>';
      htmlStr += '</div>';
    }
    
    card.innerHTML = htmlStr;
    container.appendChild(card);
  });
}
