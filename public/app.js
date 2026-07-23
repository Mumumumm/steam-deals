let allItems = [];
let itadEnabled = false;

const grid = document.getElementById('grid');
const statusEl = document.getElementById('status');
const emptyEl = document.getElementById('empty');
const fetchedAtEl = document.getElementById('fetchedAt');
const sortEl = document.getElementById('sort');
const minDiscountEl = document.getElementById('minDiscount');
const minDiscountValEl = document.getElementById('minDiscountVal');
const genreEl = document.getElementById('genre');
const playModeEl = document.getElementById('playMode');
const hideNegativeEl = document.getElementById('hideNegative');
const refreshBtn = document.getElementById('refresh');
const accessGateEl = document.getElementById('accessGate');
const accessGateMessageEl = document.getElementById('accessGateMessage');
const accessCodeInputEl = document.getElementById('accessCodeInput');
const accessCodeSubmitEl = document.getElementById('accessCodeSubmit');

const ACCESS_CODE_KEY = 'steamDealsAccessCode';

function getStoredAccessCode() {
  return localStorage.getItem(ACCESS_CODE_KEY) || '';
}

(function captureAccessCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const codeFromUrl = params.get('code');
  if (codeFromUrl) {
    localStorage.setItem(ACCESS_CODE_KEY, codeFromUrl);
    params.delete('code');
    const cleanUrl = location.pathname + (params.toString() ? '?' + params.toString() : '');
    history.replaceState({}, '', cleanUrl);
  }
})();

function showAccessGate(message) {
  accessGateMessageEl.textContent = message;
  accessGateEl.style.display = 'block';
  grid.style.display = 'none';
  statusEl.textContent = '';
}

function hideAccessGate() {
  accessGateEl.style.display = 'none';
  grid.style.display = 'grid';
}

function priceToNumber(str) {
  const digits = (str || '').replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : Infinity;
}

function tierClass(discount) {
  if (discount >= 70) return 'tier-high';
  if (discount >= 40) return 'tier-mid';
  return 'tier-low';
}

function metacriticClass(score) {
  if (score >= 75) return 'mc-high';
  if (score >= 50) return 'mc-mid';
  return 'mc-low';
}

function renderSkeleton(count) {
  grid.innerHTML = Array.from({ length: count })
    .map(() => `
      <div class="skeleton-card">
        <div class="sk-media"></div>
        <div class="sk-line" style="width: 80%"></div>
        <div class="sk-line" style="width: 50%"></div>
        <div class="sk-line" style="width: 40%; margin-left: auto;"></div>
      </div>
    `)
    .join('');
}

function populateGenreOptions() {
  const genres = new Set();
  for (const it of allItems) for (const g of it.genres || []) genres.add(g);
  const sorted = Array.from(genres).sort((a, b) => a.localeCompare(b, 'ko'));
  const current = genreEl.value;
  genreEl.innerHTML = '<option value="">전체</option>' + sorted.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  if (sorted.includes(current)) genreEl.value = current;
}

function deltaBadge(it) {
  if (it.discountDelta === null || it.discountDelta === undefined) return '<span>신규 기록</span>';
  if (it.discountDelta > 0) return `<span class="delta-up">▲ 지난번보다 ${it.discountDelta}%p 더 할인</span>`;
  if (it.discountDelta < 0) return `<span class="delta-down">▼ 지난번보다 ${-it.discountDelta}%p 할인폭 감소</span>`;
  return '<span>지난번과 동일</span>';
}

function render() {
  const minDiscount = parseInt(minDiscountEl.value, 10);
  const sortMode = sortEl.value;
  const genre = genreEl.value;
  const playMode = playModeEl.value;
  const hideNegative = hideNegativeEl.checked;

  let items = allItems.filter((it) => {
    if (it.discount < minDiscount) return false;
    if (genre && !(it.genres || []).includes(genre)) return false;
    if (playMode === 'single' && !(it.singleplayer && !it.multiplayer)) return false;
    if (playMode === 'multi' && !it.multiplayer) return false;
    if (hideNegative && /부정/.test(it.reviewText || '')) return false;
    return true;
  });

  items.sort((a, b) => {
    if (sortMode === 'discount_desc') return b.discount - a.discount;
    if (sortMode === 'discount_asc') return a.discount - b.discount;
    if (sortMode === 'price_asc') return priceToNumber(a.finalPrice) - priceToNumber(b.finalPrice);
    if (sortMode === 'price_desc') return priceToNumber(b.finalPrice) - priceToNumber(a.finalPrice);
    if (sortMode === 'name') return a.name.localeCompare(b.name, 'ko');
    return 0;
  });

  grid.innerHTML = '';
  emptyEl.style.display = items.length ? 'none' : 'block';

  for (const it of items) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    const genreChips = (it.genres || [])
      .slice(0, 3)
      .map((g) => `<span class="genre-chip">${escapeHtml(g)}</span>`)
      .join('');

    const modeChips = [
      it.singleplayer ? '<span class="mode-chip">싱글</span>' : '',
      it.multiplayer ? '<span class="mode-chip">멀티</span>' : ''
    ].join('');

    const metacriticChip = it.metacritic
      ? `<span class="metacritic-chip ${metacriticClass(it.metacritic.score)}">MC ${it.metacritic.score}</span>`
      : '';

    const hasAllTimeLow = it.allTimeLowCut !== null && it.allTimeLowCut !== undefined;

    const historyRight = itadEnabled
      ? (hasAllTimeLow ? `역대 최고 -${it.allTimeLowCut}%` : '역대 기록 없음')
      : 'API 키 미설정';

    const recordBadge = it.isNewAllTimeLow
      ? `<span class="record-badge"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l2.09 4.26 4.7.68-3.4 3.31.8 4.68L8 11.77l-4.19 2.16.8-4.68L1.21 5.94l4.7-.68L8 1z"/></svg>역대 최저가 갱신</span>`
      : '';

    a.innerHTML = `
      <div class="card-media">
        <img src="${it.image}" loading="lazy" alt="">
        <span class="tag ${tierClass(it.discount)}">-${it.discount}%</span>
        ${recordBadge}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(it.name)}</div>
        ${genreChips ? `<div class="genre-row">${genreChips}</div>` : ''}
        ${it.shortDescription ? `<div class="card-desc">${escapeHtml(it.shortDescription)}</div>` : ''}
        <div class="meta-row">
          <span>${escapeHtml(it.reviewText || it.released || '')}</span>
          ${modeChips}
          ${metacriticChip}
        </div>
        <div class="history-row">
          <span>${deltaBadge(it)}</span>
          <span>${escapeHtml(historyRight)}</span>
        </div>
        <div class="price-row">
          <span class="price-orig">${escapeHtml(it.originalPrice)}</span>
          <span class="price-final">${escapeHtml(it.finalPrice)}</span>
        </div>
      </div>
    `;
    grid.appendChild(a);
  }

  statusEl.textContent = `총 ${items.length}개 표시 중 (전체 ${allItems.length}개 중)`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

async function loadDeals() {
  const accessCode = getStoredAccessCode();
  if (!accessCode) {
    showAccessGate('이 사이트는 초대받은 사람만 볼 수 있어요. 받은 접근 코드를 입력해주세요.');
    return;
  }

  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  if (!allItems.length) {
    statusEl.textContent = '불러오는 중... (첫 실행 시 장르/멀티플레이/평점 정보 수집으로 다소 시간이 걸릴 수 있습니다)';
    renderSkeleton(12);
  }
  try {
    const res = await fetch('/api/deals?count=150', {
      headers: { 'X-Access-Code': accessCode }
    });

    if (res.status === 401) {
      localStorage.removeItem(ACCESS_CODE_KEY);
      showAccessGate('접근 코드가 올바르지 않아요. 다시 입력해주세요.');
      return;
    }
    if (res.status === 429) {
      statusEl.textContent = '요청이 너무 잦아요. 잠시 후 다시 시도해주세요.';
      return;
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    hideAccessGate();
    allItems = data.items;
    itadEnabled = data.itadEnabled;
    fetchedAtEl.textContent = '마지막 갱신 ' + new Date(data.fetchedAt).toLocaleString('ko-KR');
    populateGenreOptions();
    render();
  } catch (e) {
    statusEl.textContent = '불러오기 실패: ' + e.message;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
  }
}

function submitAccessCode() {
  const value = accessCodeInputEl.value.trim();
  if (!value) return;
  localStorage.setItem(ACCESS_CODE_KEY, value);
  loadDeals();
}

accessCodeSubmitEl.addEventListener('click', submitAccessCode);
accessCodeInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAccessCode();
});

sortEl.addEventListener('change', render);
genreEl.addEventListener('change', render);
playModeEl.addEventListener('change', render);
hideNegativeEl.addEventListener('change', render);
minDiscountEl.addEventListener('input', () => {
  minDiscountValEl.textContent = minDiscountEl.value + '%';
  render();
});
refreshBtn.addEventListener('click', loadDeals);

sortEl.value = 'discount_desc';
loadDeals();
