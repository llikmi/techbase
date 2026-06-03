/* ═══════════════════════════════════════════════════════
   TechBase — app.js
   Google Sheets API backend + Fuse.js fuzzy search
   SHA-256 password hashing, 1-hour auto-logout
═══════════════════════════════════════════════════════ */

'use strict';

// ──────────────────── CONFIG ────────────────────
// PASSWORD: change the hash below!
// Default password is: "admin123"
// Generate a new hash: https://emn178.github.io/online-tools/sha256.html
const PASSWORD_HASH = '0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c';

// Google Sheets config (saved in localStorage for convenience)
let cfg = {
  apiKey:    'AIzaSyCQe4i9h7lFWXKOG6NuMSzjDn4W3qEJ5WQ',
  sheetId:   '1n8-L-cd3nVIzmWmVPS86HyBo1tEZVd3UzE8aXFe4dRo',
  sheetName: 'Products',
};

// Auto-logout after 60 minutes
const SESSION_TIMEOUT = 120 * 60 * 1000;

// ──────────────────── STATE ────────────────────
let allProducts    = [];    // full dataset
let filteredProducts = [];  // after search/filter
let fuse           = null;  // Fuse.js instance
let sessionTimer   = null;
let sessionStart   = null;
let timerInterval  = null;
let deleteTargetId = null;
let editingId      = null;
let nextLocalId    = 1;

// ──────────────────── HELPERS ────────────────────
async function sha256(msg) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function fmtPrice(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('ru-RU', { style:'currency', currency:'RUB', maximumFractionDigits:0 });
}

function fmtNum(n) {
  return Number(n).toLocaleString('ru-RU');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Transliteration for fuzzy search
const TR_MAP = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'j',
  к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
  х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};
function translit(str) {
  return String(str).toLowerCase().split('').map(c => TR_MAP[c] !== undefined ? TR_MAP[c] : c).join('');
}

// ──────────────────── LOCAL STORAGE (DEMO MODE) ────────────────────
function saveLocal(products) {
  localStorage.setItem('tb_products', JSON.stringify(products));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem('tb_products');
    return raw ? JSON.parse(raw) : getDemoData();
  } catch { return getDemoData(); }
}

function getDemoData() {
  return [
    { id:1, name:'Смартфон Samsung Galaxy S24',    category:'Смартфоны',   brand:'Samsung', sku:'SM-S921B',  price_buy:45000, price_sale:62990, qty:15, description:'Флагманский смартфон 2024 года', specs:'Экран: 6.2" Dynamic AMOLED\nПамять: 256 ГБ\nОЗУ: 8 ГБ\nКамера: 50 МП' },
    { id:2, name:'Ноутбук Apple MacBook Air M3',   category:'Ноутбуки',    brand:'Apple',   sku:'MXCV3RU/A', price_buy:89000, price_sale:119990, qty:8,  description:'Ультратонкий ноутбук на чипе M3', specs:'Процессор: Apple M3\nОЗУ: 8 ГБ\nNVMe: 256 ГБ\nДисплей: 13.6"' },
    { id:3, name:'Наушники Sony WH-1000XM5',       category:'Аудио',       brand:'Sony',    sku:'WH1000XM5B', price_buy:18000, price_sale:26990, qty:22, description:'Беспроводные наушники с ANC', specs:'ANC: Да\nВремя работы: 30 ч\nBluetooth: 5.2' },
    { id:4, name:'Телевизор LG OLED C3 65"',       category:'Телевизоры',  brand:'LG',      sku:'OLED65C3RLA', price_buy:95000, price_sale:139990, qty:5, description:'OLED 4K телевизор 65 дюймов', specs:'Экран: 65" OLED 4K\nHDR: Dolby Vision\nChip: α9 Gen6' },
    { id:5, name:'Планшет iPad Air 5 Wi-Fi 64ГБ',  category:'Планшеты',    brand:'Apple',   sku:'MM9D3RU/A',  price_buy:42000, price_sale:59990, qty:11, description:'Планшет с чипом M1', specs:'Чип: Apple M1\nЭкран: 10.9"\nПамять: 64 ГБ' },
    { id:6, name:'Игровая консоль PlayStation 5',  category:'Консоли',     brand:'Sony',    sku:'CFI-1200A',  price_buy:32000, price_sale:47990, qty:0,  description:'Игровая консоль нового поколения', specs:'CPU: AMD Zen 2\nGPU: 10.3 TFLOPS\nNVMe: 825 ГБ' },
    { id:7, name:'Умные часы Apple Watch Series 9',category:'Смарт-часы',  brand:'Apple',   sku:'MRXH3LL/A',  price_buy:22000, price_sale:34990, qty:18, description:'Смарт-часы с чипом S9', specs:'Дисплей: Always-On Retina\nЧип: S9\nWater: 50м' },
    { id:8, name:'Роутер ASUS RT-AX88U Pro',       category:'Сетевое',     brand:'ASUS',    sku:'RT-AX88U-P', price_buy:12000, price_sale:18990, qty:7,  description:'Wi-Fi 6 роутер', specs:'Wi-Fi: 802.11ax\nСкорость: 6000 Мбит/с\nAntenna: 8' },
  ];
}

// ──────────────────── GOOGLE SHEETS API ────────────────────
const COLS = ['id','name','category','brand','sku','price_buy','price_sale','qty','description','specs'];
const RANGE_START = 2; // data starts at row 2 (row 1 = headers)

function isGSConfigured() {
  return !!(cfg.apiKey && cfg.sheetId);
}

async function gsGet() {
  const range = `${cfg.sheetName}!A:J`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(range)}?key=${cfg.apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const data = await res.json();
  const rows = data.values || [];
  // Skip header row
  return rows.slice(1).filter(r => r[0]).map(r => ({
    id:         Number(r[0]) || 0,
    name:       r[1] || '',
    category:   r[2] || '',
    brand:      r[3] || '',
    sku:        r[4] || '',
    price_buy:  Number(r[5]) || 0,
    price_sale: Number(r[6]) || 0,
    qty:        Number(r[7]) || 0,
    description:r[8] || '',
    specs:      r[9] || '',
  }));
}

async function gsAppend(product) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(cfg.sheetName + '!A:J')}:append?valueInputOption=RAW&key=${cfg.apiKey}`;
  const row = COLS.map(c => product[c] ?? '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
}

async function gsUpdate(product) {
  // Find row index in the sheet
  const allRows = await gsGetRaw();
  const rowIdx = allRows.findIndex(r => Number(r[0]) === product.id);
  if (rowIdx === -1) throw new Error('Строка не найдена в таблице');
  const sheetRow = rowIdx + 2; // +1 for header, +1 for 0-index
  const range = `${cfg.sheetName}!A${sheetRow}:J${sheetRow}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW&key=${cfg.apiKey}`;
  const row = COLS.map(c => product[c] ?? '');
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
}

async function gsDelete(id) {
  // We'll clear the row content (Google Sheets free tier doesn't support row deletion via simple API key)
  // Alternative: overwrite with empty, then on load filter empty rows
  const allRows = await gsGetRaw();
  const rowIdx = allRows.findIndex(r => Number(r[0]) === id);
  if (rowIdx === -1) throw new Error('Строка не найдена');
  const sheetRow = rowIdx + 2;
  const range = `${cfg.sheetName}!A${sheetRow}:J${sheetRow}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW&key=${cfg.apiKey}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ values: [['','','','','','','','','','']] }),
  });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
}

async function gsGetRaw() {
  const range = `${cfg.sheetName}!A:J`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values/${encodeURIComponent(range)}?key=${cfg.apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const data = await res.json();
  const rows = data.values || [];
  return rows.slice(1); // skip header
}

// Generate next ID
function nextId(products) {
  return products.length ? Math.max(...products.map(p => p.id)) + 1 : 1;
}

// ──────────────────── DATA LOAD ────────────────────
async function loadProducts() {
  setSyncStatus('loading', 'Загрузка…');
  document.getElementById('loadingState').classList.remove('d-none');
  document.getElementById('productsTable').classList.add('d-none');
  document.getElementById('emptyState').classList.add('d-none');

  try {
    if (isGSConfigured()) {
      allProducts = await gsGet();
    } else {
      allProducts = loadLocal();
      document.getElementById('configBanner').classList.remove('d-none');
    }
    buildFuse();
    applyFilters();
    setSyncStatus('ok', 'Синхронизировано');
  } catch (e) {
    console.error(e);
    setSyncStatus('error', 'Ошибка загрузки');
    allProducts = loadLocal();
    buildFuse();
    applyFilters();
  }
}

function setSyncStatus(state, text) {
  const dot  = document.querySelector('.sync-dot');
  const span = document.getElementById('syncText');
  dot.className = 'sync-dot' + (state !== 'ok' ? ` ${state}` : '');
  span.textContent = text;
}

// ──────────────────── FUSE SEARCH ────────────────────
function buildFuse() {
  // Add transliterated versions for search
  const docs = allProducts.map(p => ({
    ...p,
    _nameT: translit(p.name),
    _brandT: translit(p.brand),
    _catT: translit(p.category),
  }));

  fuse = new Fuse(docs, {
    keys: [
      { name: 'name',       weight: 0.4 },
      { name: 'brand',      weight: 0.2 },
      { name: 'sku',        weight: 0.2 },
      { name: 'category',   weight: 0.1 },
      { name: 'description',weight: 0.05 },
      { name: '_nameT',     weight: 0.3 },
      { name: '_brandT',    weight: 0.15 },
      { name: '_catT',      weight: 0.08 },
    ],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  populateFilterDropdowns();
}

// ──────────────────── FILTERS & SEARCH ────────────────────
function applyFilters() {
  const query    = document.getElementById('searchInput').value.trim();
  const catF     = document.getElementById('filterCategory').value;
  const brandF   = document.getElementById('filterBrand').value;
  const priceMin = parseFloat(document.getElementById('filterPriceMin').value) || 0;
  const priceMax = parseFloat(document.getElementById('filterPriceMax').value) || Infinity;
  const stockF   = document.getElementById('filterStock').value;

  let result;

  if (query && fuse) {
    // Try original query + transliterated
    const q2 = translit(query);
    const r1 = fuse.search(query).map(r => r.item);
    const r2 = query !== q2 ? fuse.search(q2).map(r => r.item) : [];
    // Merge, deduplicate by id
    const seen = new Set();
    result = [...r1, ...r2].filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  } else {
    result = [...allProducts];
  }

  // Filter
  result = result.filter(p => {
    if (catF && p.category !== catF) return false;
    if (brandF && p.brand !== brandF) return false;
    if (p.price_sale < priceMin || p.price_sale > priceMax) return false;
    if (stockF === 'in'  && p.qty <= 0) return false;
    if (stockF === 'out' && p.qty >  0) return false;
    return true;
  });

  // Sort
  const sort = document.getElementById('sortSelect').value;
  const [col, dir] = sort.split('_');
  const fieldMap = { name:'name', price:'price_sale', qty:'qty', id:'id' };
  const field = { name:'name', price:'price_sale', qty:'qty', id:'id' }[col] || 'name';
  result.sort((a, b) => {
    let va = a[field], vb = b[field];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  filteredProducts = result;
  renderTable();
  updateFilterCount();
}

function populateFilterDropdowns() {
  const categories = [...new Set(allProducts.map(p => p.category).filter(Boolean))].sort();
  const brands     = [...new Set(allProducts.map(p => p.brand).filter(Boolean))].sort();

  const catSel = document.getElementById('filterCategory');
  const curCat = catSel.value;
  catSel.innerHTML = '<option value="">Все</option>' + categories.map(c => `<option value="${c}">${c}</option>`).join('');
  catSel.value = curCat;

  const bSel = document.getElementById('filterBrand');
  const curB = bSel.value;
  bSel.innerHTML = '<option value="">Все</option>' + brands.map(b => `<option value="${b}">${b}</option>`).join('');
  bSel.value = curB;

  // Datalists for form
  document.getElementById('categoryList').innerHTML = categories.map(c => `<option value="${c}">`).join('');
  document.getElementById('brandList').innerHTML    = brands.map(b => `<option value="${b}">`).join('');
}

function updateFilterCount() {
  const catF = document.getElementById('filterCategory').value;
  const brandF = document.getElementById('filterBrand').value;
  const priceMin = document.getElementById('filterPriceMin').value;
  const priceMax = document.getElementById('filterPriceMax').value;
  const stockF = document.getElementById('filterStock').value;
  const count = [catF, brandF, priceMin, priceMax, stockF].filter(Boolean).length;
  const badge = document.getElementById('filterCount');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('d-none');
    document.getElementById('filterToggle').classList.add('active');
  } else {
    badge.classList.add('d-none');
    document.getElementById('filterToggle').classList.remove('active');
  }
}

// ──────────────────── RENDER TABLE ────────────────────
function renderTable() {
  const loading = document.getElementById('loadingState');
  const empty   = document.getElementById('emptyState');
  const table   = document.getElementById('productsTable');
  const tbody   = document.getElementById('productsBody');

  loading.classList.add('d-none');

  document.getElementById('resultCount').textContent =
    `${filteredProducts.length} ${plural(filteredProducts.length,'товар','товара','товаров')}`;

  if (filteredProducts.length === 0) {
    empty.classList.remove('d-none');
    table.classList.add('d-none');
    return;
  }

  empty.classList.add('d-none');
  table.classList.remove('d-none');

  tbody.innerHTML = filteredProducts.map(p => {
    const stockClass = p.qty <= 0 ? 'stock-out' : p.qty < 3 ? 'stock-low' : 'stock-in';
    const stockLabel = p.qty <= 0 ? 'Нет' : p.qty;
    const margin = p.price_buy > 0 ? Math.round((p.price_sale - p.price_buy) / p.price_buy * 100) : null;
    return `
    <tr>
      <td class="td-id">#${p.id}</td>
      <td>
        <div class="td-name">${escHtml(p.name)}</div>
        ${p.sku ? `<div class="td-sku">${escHtml(p.sku)}</div>` : ''}
      </td>
      <td class="d-none d-md-table-cell">
        <span class="badge" style="background:var(--bg3);color:var(--text2);font-weight:600;font-size:11px">${escHtml(p.category||'—')}</span>
      </td>
      <td class="d-none d-lg-table-cell">${escHtml(p.brand||'—')}</td>
      <td class="td-sku d-none d-lg-table-cell">${escHtml(p.sku||'—')}</td>
      <td class="td-buy-price d-none d-md-table-cell">${fmtPrice(p.price_buy)}</td>
      <td class="td-price">
        ${fmtPrice(p.price_sale)}
        ${margin !== null ? `<div style="font-size:10px;color:${margin>=0?'var(--green)':'var(--red)'}">+${margin}%</div>` : ''}
      </td>
      <td><span class="stock-badge ${stockClass}">${stockLabel}</span></td>
      <td class="actions-cell">
        <button class="btn-row" onclick="editProduct(${p.id})" title="Редактировать"><i class="bi bi-pencil-fill"></i></button>
        <button class="btn-row delete" onclick="confirmDelete(${p.id},'${escHtml(p.name)}')" title="Удалить"><i class="bi bi-trash3-fill"></i></button>
      </td>
    </tr>`;
  }).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

// ──────────────────── PRODUCT FORM ────────────────────
function resetForm() {
  editingId = null;
  document.getElementById('editId').value = '';
  document.getElementById('formTitle').textContent = 'Добавить товар';
  document.getElementById('saveBtnText').textContent = 'Сохранить товар';
  document.getElementById('cancelEditBtn').style.display = 'none';
  ['fName','fSku','fCategory','fBrand','fQty','fPriceBuy','fPriceSale','fDesc','fSpecs']
    .forEach(id => document.getElementById(id).value = '');
  updateMargin();
  document.getElementById('formSuccess').classList.add('d-none');
  document.getElementById('formError').classList.add('d-none');
}

function fillForm(p) {
  editingId = p.id;
  document.getElementById('editId').value = p.id;
  document.getElementById('formTitle').textContent = 'Редактировать товар';
  document.getElementById('saveBtnText').textContent = 'Сохранить изменения';
  document.getElementById('cancelEditBtn').style.display = '';
  document.getElementById('fName').value      = p.name || '';
  document.getElementById('fSku').value       = p.sku || '';
  document.getElementById('fCategory').value  = p.category || '';
  document.getElementById('fBrand').value     = p.brand || '';
  document.getElementById('fQty').value       = p.qty ?? '';
  document.getElementById('fPriceBuy').value  = p.price_buy || '';
  document.getElementById('fPriceSale').value = p.price_sale || '';
  document.getElementById('fDesc').value      = p.description || '';
  document.getElementById('fSpecs').value     = p.specs || '';
  updateMargin();
  document.getElementById('formSuccess').classList.add('d-none');
  document.getElementById('formError').classList.add('d-none');
  showView('add');
}

function updateMargin() {
  const buy  = parseFloat(document.getElementById('fPriceBuy').value)  || 0;
  const sale = parseFloat(document.getElementById('fPriceSale').value) || 0;
  const el = document.getElementById('marginDisplay');
  if (!buy || !sale) { el.textContent = '—'; el.className = 'margin-display'; return; }
  const pct = Math.round((sale - buy) / buy * 100);
  const rub = sale - buy;
  el.textContent = `${pct >= 0 ? '+' : ''}${pct}% (${fmtPrice(rub)})`;
  el.className = 'margin-display ' + (pct >= 0 ? 'margin-positive' : 'margin-negative');
}

function getFormProduct() {
  const name  = document.getElementById('fName').value.trim();
  const cat   = document.getElementById('fCategory').value.trim();
  const qty   = parseInt(document.getElementById('fQty').value) || 0;
  const pSale = parseFloat(document.getElementById('fPriceSale').value) || 0;
  if (!name || !cat || pSale <= 0) return null;
  return {
    id:          editingId || nextId(allProducts),
    name,
    category:    cat,
    brand:       document.getElementById('fBrand').value.trim(),
    sku:         document.getElementById('fSku').value.trim(),
    price_buy:   parseFloat(document.getElementById('fPriceBuy').value) || 0,
    price_sale:  pSale,
    qty,
    description: document.getElementById('fDesc').value.trim(),
    specs:       document.getElementById('fSpecs').value.trim(),
  };
}

async function saveProduct() {
  const p = getFormProduct();
  if (!p) {
    showFormMsg('error', 'Заполните обязательные поля: Название, Категория, Цена продажи');
    return;
  }

  const btn = document.getElementById('saveProductBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner me-2" style="display:inline-block;width:16px;height:16px"></span> Сохранение…';

  try {
    if (isGSConfigured()) {
      if (editingId) await gsUpdate(p);
      else           await gsAppend(p);
    }

    if (editingId) {
      const idx = allProducts.findIndex(x => x.id === editingId);
      if (idx >= 0) allProducts[idx] = p; else allProducts.push(p);
    } else {
      allProducts.push(p);
    }
    saveLocal(allProducts);
    buildFuse();
    applyFilters();
    updateStats();

    showFormMsg('success', editingId ? 'Изменения сохранены!' : 'Товар успешно добавлен!');
    if (!editingId) resetForm();

  } catch(e) {
    console.error(e);
    showFormMsg('error', 'Ошибка при сохранении: ' + e.message);
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-floppy-fill me-2"></i><span id="saveBtnText">' + (editingId ? 'Сохранить изменения' : 'Сохранить товар') + '</span>';
}

function showFormMsg(type, msg) {
  document.getElementById('formSuccess').classList.add('d-none');
  document.getElementById('formError').classList.add('d-none');
  const el = document.getElementById(type === 'success' ? 'formSuccess' : 'formError');
  const sp = document.getElementById(type === 'success' ? 'formSuccessText' : 'formErrorText');
  sp.textContent = msg;
  el.classList.remove('d-none');
  el.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

// ──────────────────── EDIT / DELETE ────────────────────
function editProduct(id) {
  const p = allProducts.find(x => x.id === id);
  if (p) fillForm(p);
}

function confirmDelete(id, name) {
  deleteTargetId = id;
  document.getElementById('deleteModalText').textContent = `Удалить "${name}"? Это действие нельзя отменить.`;
  document.getElementById('deleteModal').classList.remove('d-none');
}

async function doDelete() {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  document.getElementById('deleteModal').classList.add('d-none');
  deleteTargetId = null;

  try {
    if (isGSConfigured()) await gsDelete(id);
    allProducts = allProducts.filter(p => p.id !== id);
    saveLocal(allProducts);
    buildFuse();
    applyFilters();
    updateStats();
    setSyncStatus('ok', 'Удалено');
  } catch(e) {
    alert('Ошибка удаления: ' + e.message);
  }
}

// ──────────────────── STATS ────────────────────
function updateStats() {
  const total    = allProducts.length;
  const inStock  = allProducts.filter(p => p.qty > 0).length;
  const outStock = allProducts.filter(p => p.qty <= 0).length;
  const invVal   = allProducts.reduce((s, p) => s + (p.price_buy || 0) * (p.qty || 0), 0);
  const cats     = new Set(allProducts.map(p => p.category).filter(Boolean)).size;
  const brands   = new Set(allProducts.map(p => p.brand).filter(Boolean)).size;

  document.getElementById('statTotal').textContent       = total;
  document.getElementById('statInStock').textContent     = inStock;
  document.getElementById('statOutStock').textContent    = outStock;
  document.getElementById('statInventoryValue').textContent = fmtPrice(invVal);
  document.getElementById('statCategories').textContent  = cats;
  document.getElementById('statBrands').textContent      = brands;

  renderBarChart('categoryChart', countBy(allProducts, 'category'));
  renderBarChart('brandChart',    countBy(allProducts, 'brand'));
}

function countBy(arr, key) {
  const map = {};
  arr.forEach(p => { const v = p[key] || '—'; map[v] = (map[v]||0) + p.qty || (map[v]||0) + 1; });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,8);
}

function renderBarChart(containerId, data) {
  const el = document.getElementById(containerId);
  if (!data.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px">Нет данных</div>'; return; }
  const max = data[0][1];
  el.innerHTML = data.map(([label, val]) => `
    <div class="bar-row">
      <div class="bar-label" title="${escHtml(label)}">${escHtml(label)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.round(val/max*100)}%"></div>
      </div>
      <div class="bar-num">${val}</div>
    </div>`).join('');
}

// ──────────────────── VIEWS ────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view' + name.charAt(0).toUpperCase() + name.slice(1)).classList.add('active');
  document.querySelector(`[data-view="${name}"]`)?.classList.add('active');
  const titles = { products:'Товары', add:'Добавить товар', stats:'Статистика' };
  document.getElementById('topbarTitle').textContent = titles[name] || '';
  if (name === 'stats') updateStats();
  closeSidebar();
}

// ──────────────────── SESSION ────────────────────
function startSession() {
  sessionStart = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(tickTimer, 1000);

  // Reset on activity
  ['mousemove','keydown','click','touchstart'].forEach(evt =>
    document.addEventListener(evt, resetSessionTimer, { passive:true })
  );
}

function resetSessionTimer() {
  sessionStart = Date.now();
}

function tickTimer() {
  const elapsed = Date.now() - sessionStart;
  const remaining = SESSION_TIMEOUT - elapsed;
  if (remaining <= 0) {
    logout();
    return;
  }
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  document.getElementById('timerText').textContent = `${m}:${s.toString().padStart(2,'0')}`;
}

function logout() {
  clearInterval(timerInterval);
  document.getElementById('dashboard').classList.add('d-none');
  document.getElementById('loginScreen').classList.remove('d-none');
  document.getElementById('passwordInput').value = '';
  allProducts = [];
  filteredProducts = [];
}

// ──────────────────── SIDEBAR ────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  let bd = document.getElementById('sidebarBackdrop');
  if (!bd) {
    bd = document.createElement('div');
    bd.id = 'sidebarBackdrop';
    bd.className = 'sidebar-backdrop show';
    bd.onclick = closeSidebar;
    document.body.appendChild(bd);
  } else {
    bd.classList.add('show');
  }
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  const bd = document.getElementById('sidebarBackdrop');
  if (bd) bd.classList.remove('show');
}

// ──────────────────── SETTINGS ────────────────────
function openSettings() {
  document.getElementById('cfgApiKey').value    = cfg.apiKey;
  document.getElementById('cfgSheetId').value   = cfg.sheetId;
  document.getElementById('cfgSheetName').value = cfg.sheetName || 'Products';
  document.getElementById('settingsModal').classList.remove('d-none');
}

function saveSettings() {
  cfg.apiKey    = document.getElementById('cfgApiKey').value.trim();
  cfg.sheetId   = document.getElementById('cfgSheetId').value.trim();
  cfg.sheetName = document.getElementById('cfgSheetName').value.trim() || 'Products';
  localStorage.setItem('tb_apiKey',    cfg.apiKey);
  localStorage.setItem('tb_sheetId',   cfg.sheetId);
  localStorage.setItem('tb_sheetName', cfg.sheetName);
  document.getElementById('settingsModal').classList.add('d-none');
  if (isGSConfigured()) {
    document.getElementById('configBanner').classList.add('d-none');
    loadProducts();
  }
}

// ──────────────────── INIT ────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // ── LOGIN ──
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const pw = document.getElementById('passwordInput').value;
    const hash = await sha256(pw);
    if (hash === PASSWORD_HASH) {
      document.getElementById('loginError').classList.add('d-none');
      document.getElementById('loginScreen').classList.add('d-none');
      document.getElementById('dashboard').classList.remove('d-none');
      startSession();
      await loadProducts();
    } else {
      document.getElementById('loginError').classList.remove('d-none');
      document.getElementById('passwordInput').value = '';
      document.getElementById('passwordInput').focus();
    }
  });

  document.getElementById('passwordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('loginBtn').click();
  });

  document.getElementById('togglePw').addEventListener('click', () => {
    const inp = document.getElementById('passwordInput');
    const icon = document.getElementById('eyeIcon');
    if (inp.type === 'password') {
      inp.type = 'text';
      icon.className = 'bi bi-eye-slash';
    } else {
      inp.type = 'password';
      icon.className = 'bi bi-eye';
    }
  });

  // ── NAV ──
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const view = item.dataset.view;
      if (view === 'add') resetForm();
      showView(view);
    });
  });

  document.getElementById('addProductBtnSm').addEventListener('click', () => {
    resetForm();
    showView('add');
  });

  // ── SIDEBAR TOGGLE ──
  document.getElementById('sidebarToggle').addEventListener('click', openSidebar);
  document.getElementById('sidebarClose').addEventListener('click', closeSidebar);

  // ── SEARCH ──
  const debouncedFilter = debounce(applyFilters, 120);
  document.getElementById('searchInput').addEventListener('input', () => {
    const q = document.getElementById('searchInput').value;
    document.getElementById('clearSearch').classList.toggle('d-none', !q);
    debouncedFilter();
  });

  document.getElementById('clearSearch').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('clearSearch').classList.add('d-none');
    applyFilters();
  });

  // ── FILTERS ──
  document.getElementById('filterToggle').addEventListener('click', () => {
    document.getElementById('filtersPanel').classList.toggle('d-none');
  });

  ['filterCategory','filterBrand','filterStock','sortSelect'].forEach(id =>
    document.getElementById(id).addEventListener('change', applyFilters)
  );

  document.getElementById('filterPriceMin').addEventListener('input', debouncedFilter);
  document.getElementById('filterPriceMax').addEventListener('input', debouncedFilter);

  document.getElementById('clearFilters').addEventListener('click', () => {
    document.getElementById('filterCategory').value = '';
    document.getElementById('filterBrand').value    = '';
    document.getElementById('filterPriceMin').value = '';
    document.getElementById('filterPriceMax').value = '';
    document.getElementById('filterStock').value    = '';
    applyFilters();
  });

  // ── TABLE SORT (header click) ──
  document.querySelectorAll('.col-sort').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const sel = document.getElementById('sortSelect');
      const cur = sel.value;
      const [curCol, curDir] = cur.split('_');
      const newDir = (curCol === col && curDir === 'asc') ? 'desc' : 'asc';
      const optVal = `${col}_${newDir}`;
      // Try to set the select value
      const opt = sel.querySelector(`option[value="${optVal}"]`);
      if (opt) sel.value = optVal;
      applyFilters();
    });
  });

  // ── FORM ──
  document.getElementById('saveProductBtn').addEventListener('click', saveProduct);
  document.getElementById('cancelEditBtn').addEventListener('click', () => {
    resetForm();
    showView('products');
  });

  document.getElementById('fPriceBuy').addEventListener('input', updateMargin);
  document.getElementById('fPriceSale').addEventListener('input', updateMargin);

  // ── DELETE MODAL ──
  document.getElementById('confirmDeleteBtn').addEventListener('click', doDelete);
  document.getElementById('cancelDeleteBtn').addEventListener('click', () => {
    document.getElementById('deleteModal').classList.add('d-none');
    deleteTargetId = null;
  });

  // ── SETTINGS ──
  document.getElementById('configLink').addEventListener('click', e => {
    e.preventDefault();
    openSettings();
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('cancelSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.add('d-none');
  });

  // ── LOGOUT ──
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // ── REFRESH ──
  document.getElementById('refreshBtn').addEventListener('click', loadProducts);

  // ── CLOSE MODALS ON OVERLAY CLICK ──
  document.getElementById('deleteModal').addEventListener('click', e => {
    if (e.target === document.getElementById('deleteModal'))
      document.getElementById('deleteModal').classList.add('d-none');
  });
  document.getElementById('settingsModal').addEventListener('click', e => {
    if (e.target === document.getElementById('settingsModal'))
      document.getElementById('settingsModal').classList.add('d-none');
  });

  // Init form cancel button hidden
  document.getElementById('cancelEditBtn').style.display = 'none';
});
