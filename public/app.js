/* ─── Estado global ──────────────────────────────────────────────────────── */
const state = {
  config: {},
  collections: [],      // datos sincronizados de Shopify
  filteredCollections: [], // resultado de búsqueda
};

/* ─── Utilidades ─────────────────────────────────────────────────────────── */
function formatPrice(value, sep) {
  if (value == null || isNaN(value)) return '—';
  const n = parseFloat(value);
  if (sep === ',') {
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  return n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function calcDistributorPrice(cost, margin) {
  if (cost == null || isNaN(cost)) return null;
  return cost * (1 + (parseFloat(margin) || 0) / 100);
}

function showMsg(el, text, type = 'success') {
  el.textContent = text;
  el.className = `msg msg--${type}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function showMsgPersist(el, text, type = 'success') {
  el.textContent = text;
  el.className = `msg msg--${type}`;
  el.style.display = 'block';
}

/* ─── Tabs ───────────────────────────────────────────────────────────────── */
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });
  if (tabId === 'pdf') refreshPdfTab();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ─── Configuración ──────────────────────────────────────────────────────── */
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.ok) {
      state.config = data.config;
      fillConfigForm(data.config);
    }
  } catch (e) {
    console.error('Error cargando config:', e);
  }
}

function fillConfigForm(cfg) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('shopifyStore', cfg.shopifyStore);
  set('shopifyToken', cfg.shopifyToken);
  set('logoUrl', cfg.logoUrl);
  set('primaryColor', cfg.primaryColor || '#1a56db');
  set('primaryColorText', cfg.primaryColor || '#1a56db');
  set('secondaryColor', cfg.secondaryColor || '#6875f5');
  set('secondaryColorText', cfg.secondaryColor || '#6875f5');
  set('currencySymbol', cfg.currencySymbol || 'COP');
  set('thousandSeparator', cfg.thousandSeparator || '.');
  set('footerMessage', cfg.footerMessage);

  // Sync select value
  const sep = document.getElementById('thousandSeparator');
  if (sep) sep.value = cfg.thousandSeparator || '.';
}

// Sincronizar color picker ↔ texto
['primary', 'secondary'].forEach(key => {
  const picker = document.getElementById(`${key}Color`);
  const textInput = document.getElementById(`${key}ColorText`);
  if (!picker || !textInput) return;
  picker.addEventListener('input', () => { textInput.value = picker.value; });
  textInput.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(textInput.value)) {
      picker.value = textInput.value;
    }
  });
});

document.getElementById('saveConfigBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveConfigBtn');
  const msg = document.getElementById('saveMsg');
  btn.disabled = true;

  const newConfig = {
    shopifyStore: document.getElementById('shopifyStore').value.trim(),
    shopifyToken: document.getElementById('shopifyToken').value.trim(),
    logoUrl: document.getElementById('logoUrl').value.trim(),
    primaryColor: document.getElementById('primaryColorText').value.trim() || document.getElementById('primaryColor').value,
    secondaryColor: document.getElementById('secondaryColorText').value.trim() || document.getElementById('secondaryColor').value,
    currencySymbol: document.getElementById('currencySymbol').value.trim() || 'COP',
    thousandSeparator: document.getElementById('thousandSeparator').value,
    footerMessage: document.getElementById('footerMessage').value.trim(),
  };

  // Incluir márgenes actuales desde el formulario
  const marginInputs = document.querySelectorAll('[data-margin-id]');
  const collectionMargins = { ...(state.config.collectionMargins || {}) };
  marginInputs.forEach(input => {
    collectionMargins[input.dataset.marginId] = parseFloat(input.value) || 0;
  });
  newConfig.collectionMargins = collectionMargins;

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig),
    });
    const data = await res.json();
    if (data.ok) {
      state.config = { ...state.config, ...newConfig };
      showMsg(msg, data.message, 'success');
    } else {
      showMsg(msg, data.error || 'Error al guardar.', 'error');
    }
  } catch (e) {
    showMsg(msg, 'Sin conexión con el servidor.', 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ─── Márgenes por colección ─────────────────────────────────────────────── */
function renderMargins(collections) {
  const container = document.getElementById('marginsContainer');
  if (!collections || collections.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Sincroniza los productos para ver las colecciones.</p></div>';
    return;
  }
  container.innerHTML = collections.map(col => {
    const margin = state.config.collectionMargins?.[col.id] || 0;
    return `
      <div class="margin-row">
        <span class="margin-row-name">${escHtml(col.title)}</span>
        <div class="margin-row-input">
          <input type="number" min="0" max="1000" step="0.1"
            data-margin-id="${col.id}"
            value="${margin}"
            style="width:90px;border:1px solid var(--gray-300);border-radius:6px;padding:6px 10px;font-size:14px;" />
          <span style="color:var(--gray-500);">%</span>
        </div>
      </div>`;
  }).join('');
}

/* ─── Sincronización ─────────────────────────────────────────────────────── */
document.getElementById('syncBtn').addEventListener('click', syncProducts);

async function syncProducts() {
  const btn = document.getElementById('syncBtn');
  const progress = document.getElementById('syncProgress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('syncStatusText');

  btn.disabled = true;
  progress.style.display = 'flex';
  dot.className = 'status-dot syncing';
  statusText.textContent = 'Sincronizando...';

  // Animación de progreso simulada (la sync es async)
  let fakeProgress = 0;
  const fakeInterval = setInterval(() => {
    fakeProgress = Math.min(fakeProgress + Math.random() * 12, 85);
    progressFill.style.width = fakeProgress + '%';
    if (fakeProgress < 30) progressText.textContent = 'Conectando con Shopify...';
    else if (fakeProgress < 55) progressText.textContent = 'Descargando productos...';
    else if (fakeProgress < 75) progressText.textContent = 'Obteniendo costos de inventario...';
    else progressText.textContent = 'Procesando datos...';
  }, 600);

  try {
    const res = await fetch('/api/sync');
    const data = await res.json();
    clearInterval(fakeInterval);

    if (data.ok) {
      progressFill.style.width = '100%';
      progressText.textContent = `¡Listo! ${data.totalProducts} productos, ${data.totalVariants} variantes`;
      state.collections = data.collections;
      state.config.collectionMargins = state.config.collectionMargins || {};

      // Actualizar config desde el servidor
      const configRes = await fetch('/api/config');
      const configData = await configRes.json();
      if (configData.ok) state.config = configData.config;

      dot.className = 'status-dot synced';
      statusText.textContent = `Sincronizado · ${new Date(data.lastSync).toLocaleTimeString('es-CO')}`;

      renderMargins(data.collections);
      renderCollections(data.collections);
      updateHiddenBadge();
      refreshPdfTab();

      setTimeout(() => { progress.style.display = 'none'; }, 2000);
    } else {
      clearInterval(fakeInterval);
      progressFill.style.width = '0%';
      progressText.textContent = '';
      progress.style.display = 'none';
      dot.className = 'status-dot error';
      statusText.textContent = 'Error de sincronización';

      document.getElementById('productsContainer').innerHTML = `
        <div class="section-card">
          <div class="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p class="text-danger">${escHtml(data.error || 'Error al sincronizar.')}</p>
            <p>Verifica las credenciales en la pestaña <strong>Configuración</strong>.</p>
          </div>
        </div>`;
    }
  } catch (e) {
    clearInterval(fakeInterval);
    progress.style.display = 'none';
    dot.className = 'status-dot error';
    statusText.textContent = 'Sin conexión';
  } finally {
    btn.disabled = false;
  }
}

/* ─── Render de productos ────────────────────────────────────────────────── */
function renderCollections(collections, searchTerm = '') {
  const container = document.getElementById('productsContainer');
  const cfg = state.config;
  const sep = cfg.thousandSeparator || '.';
  const currency = cfg.currencySymbol || 'COP';
  const hidden = { products: new Set(cfg.hiddenProducts || []), variants: new Set(cfg.hiddenVariants || []), collections: new Set(cfg.hiddenCollections || []) };

  const term = searchTerm.toLowerCase().trim();
  let totalVisible = 0, totalHidden = 0;

  const groups = collections.map(col => {
    const margin = parseFloat(cfg.collectionMargins?.[col.id] || 0);
    const filtered = col.products.filter(p =>
      !term || p.title.toLowerCase().includes(term) ||
      p.variants.some(v => v.title.toLowerCase().includes(term))
    );
    return { ...col, filtered, margin };
  }).filter(col => col.filtered.length > 0);

  if (groups.length === 0) {
    container.innerHTML = `<div class="section-card"><div class="empty-state"><p>${term ? 'No se encontraron productos con ese término.' : 'No hay productos cargados.'}</p></div></div>`;
    return;
  }

  container.innerHTML = groups.map(col => {
    const isCollectionHidden = hidden.collections.has(String(col.id));
    const rows = col.filtered.flatMap(product => {
      return product.variants.map((variant, vi) => {
        const isProductHidden = hidden.products.has(String(product.id));
        const isVariantHidden = hidden.variants.has(String(variant.id));
        const isHidden = isProductHidden || isVariantHidden;
        if (isHidden) totalHidden++;
        else totalVisible++;

        const distPrice = calcDistributorPrice(variant.cost, col.margin);
        const imgSrc = variant.image || product.image;
        const imgHtml = imgSrc
          ? `<img src="${escAttr(imgSrc)}" class="product-img" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><div class="product-img-placeholder" style="display:none"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`
          : `<div class="product-img-placeholder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`;

        const costDisplay = variant.cost != null ? `${currency} ${formatPrice(variant.cost, sep)}` : `<span class="price-no-cost">Sin costo</span>`;
        const distDisplay = distPrice != null
          ? `${currency} ${formatPrice(distPrice, sep)}`
          : `<span class="price-no-cost">Sin costo</span>`;

        return `
          <tr class="${isHidden ? 'row-hidden' : ''}" data-product-id="${product.id}" data-variant-id="${variant.id}">
            <td>${vi === 0 ? `<div class="product-name-cell">${imgHtml}</div>` : ''}</td>
            <td>${vi === 0 ? `<span class="product-name">${escHtml(product.title)}</span>` : ''}</td>
            <td class="variant-name">${product.variants.length > 1 ? escHtml(variant.title) : '—'}</td>
            <td class="price-cell">${costDisplay}</td>
            <td class="price-cell">${currency} ${formatPrice(variant.price, sep)}</td>
            <td class="price-cell">${distDisplay}</td>
            <td>
              <div style="display:flex;gap:8px;align-items:center;">
                ${vi === 0 ? `<label class="toggle-switch" title="Ocultar/mostrar producto completo">
                  <input type="checkbox" class="product-toggle" data-id="${product.id}" ${!isProductHidden ? 'checked' : ''} />
                  <span class="toggle-slider"></span>
                </label>` : ''}
                <label class="toggle-switch" title="Ocultar/mostrar esta variante">
                  <input type="checkbox" class="variant-toggle" data-id="${variant.id}" ${!isVariantHidden ? 'checked' : ''} />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </td>
          </tr>`;
      });
    }).join('');

    return `
      <div class="collection-group" id="col-group-${col.id}">
        <div class="collection-header" data-col-id="${col.id}">
          <span class="collection-header-title">${escHtml(col.title)}</span>
          <span class="collection-header-count">${col.filtered.length} productos · ${col.margin}% margen</span>
          <button class="collection-toggle-btn" data-col-id="${col.id}" onclick="event.stopPropagation()">
            ${isCollectionHidden ? 'Mostrar colección' : 'Ocultar colección'}
          </button>
        </div>
        <div class="collection-body ${isCollectionHidden ? 'collapsed' : ''}" id="col-body-${col.id}">
          <table class="products-table">
            <thead>
              <tr>
                <th style="width:52px"></th>
                <th>Producto</th>
                <th>Variante</th>
                <th>Costo</th>
                <th>Precio web</th>
                <th>Precio distribuidor</th>
                <th style="width:90px">Visible</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  // Bind toggles
  container.querySelectorAll('.product-toggle').forEach(cb => {
    cb.addEventListener('change', () => toggleVisibility('product', cb.dataset.id, cb.checked));
  });
  container.querySelectorAll('.variant-toggle').forEach(cb => {
    cb.addEventListener('change', () => toggleVisibility('variant', cb.dataset.id, cb.checked));
  });
  container.querySelectorAll('.collection-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleCollectionVisibility(btn.dataset.colId); });
  });
  container.querySelectorAll('.collection-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = document.getElementById(`col-body-${header.dataset.colId}`);
      if (body) body.classList.toggle('collapsed');
    });
  });

  updateStats(totalVisible, totalHidden);
}

async function toggleVisibility(type, id, isVisible) {
  const cfg = state.config;
  if (type === 'product') {
    const arr = new Set(cfg.hiddenProducts || []);
    isVisible ? arr.delete(String(id)) : arr.add(String(id));
    cfg.hiddenProducts = [...arr];
  } else {
    const arr = new Set(cfg.hiddenVariants || []);
    isVisible ? arr.delete(String(id)) : arr.add(String(id));
    cfg.hiddenVariants = [...arr];
  }

  // Actualizar fila visualmente sin re-render completo
  const row = document.querySelector(`[data-${type === 'product' ? 'product' : 'variant'}-id="${id}"]`);
  // Hacemos re-render parcial
  const term = document.getElementById('searchInput').value;
  renderCollections(state.collections, term);

  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hiddenProducts: cfg.hiddenProducts, hiddenVariants: cfg.hiddenVariants }),
  });
  updateHiddenBadge();
  refreshPdfTab();
}

async function toggleCollectionVisibility(colId) {
  const cfg = state.config;
  const arr = new Set(cfg.hiddenCollections || []);
  const isHidden = arr.has(String(colId));
  isHidden ? arr.delete(String(colId)) : arr.add(String(colId));
  cfg.hiddenCollections = [...arr];

  const term = document.getElementById('searchInput').value;
  renderCollections(state.collections, term);

  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hiddenCollections: cfg.hiddenCollections }),
  });
  refreshPdfTab();
}

function updateStats(visible, hidden) {
  const el = document.getElementById('productStats');
  if (el) el.textContent = `${visible} visibles · ${hidden} ocultos`;
  updateHiddenBadge(hidden);
}

function updateHiddenBadge(count) {
  const badge = document.getElementById('hiddenBadge');
  if (!badge) return;
  const hiddenCount = count !== undefined ? count :
    (state.config.hiddenProducts?.length || 0) + (state.config.hiddenVariants?.length || 0);
  if (hiddenCount > 0) {
    badge.textContent = hiddenCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

/* ─── Búsqueda ───────────────────────────────────────────────────────────── */
let searchTimeout = null;
document.getElementById('searchInput').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (state.collections.length > 0) {
      renderCollections(state.collections, e.target.value);
    }
  }, 250);
});

/* ─── Pestaña PDF ────────────────────────────────────────────────────────── */
function refreshPdfTab() {
  renderPdfCollections();
  updatePdfSummary();
  loadPdfHistory();
}

function renderPdfCollections() {
  const container = document.getElementById('pdfCollectionsContainer');
  const cfg = state.config;

  if (state.collections.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Sincroniza los productos primero.</p></div>';
    document.getElementById('generatePdfBtn').disabled = true;
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:12px;display:flex;gap:10px;">
      <button class="btn btn--secondary" onclick="selectAllPdfCollections(true)">Seleccionar todo</button>
      <button class="btn btn--secondary" onclick="selectAllPdfCollections(false)">Deseleccionar todo</button>
    </div>
    <div class="pdf-collections-list">
      ${state.collections.map(col => {
        const hiddenCols = new Set(cfg.hiddenCollections || []);
        const checked = !hiddenCols.has(String(col.id));
        const visibleProducts = col.products.filter(p => !new Set(cfg.hiddenProducts || []).has(String(p.id)));
        return `
          <label class="pdf-collection-item">
            <input type="checkbox" class="pdf-col-check" data-col-id="${col.id}" ${checked ? 'checked' : ''} onchange="updatePdfSummary()" />
            <span class="pdf-collection-name">${escHtml(col.title)}</span>
            <span class="pdf-collection-count">${visibleProducts.length} productos</span>
          </label>`;
      }).join('')}
    </div>`;
  document.getElementById('generatePdfBtn').disabled = false;
}

function selectAllPdfCollections(select) {
  document.querySelectorAll('.pdf-col-check').forEach(cb => { cb.checked = select; });
  updatePdfSummary();
}

function updatePdfSummary() {
  const cfg = state.config;
  const hiddenProducts = new Set(cfg.hiddenProducts || []);
  const hiddenVariants = new Set(cfg.hiddenVariants || []);
  const selectedCols = getSelectedCollections();

  let totalProducts = 0, totalVariants = 0;
  for (const col of state.collections) {
    if (!selectedCols.includes(String(col.id))) continue;
    for (const p of col.products) {
      if (hiddenProducts.has(String(p.id))) continue;
      const visibleVariants = p.variants.filter(v => !hiddenVariants.has(String(v.id)));
      if (visibleVariants.length > 0) {
        totalProducts++;
        totalVariants += visibleVariants.length;
      }
    }
  }

  document.getElementById('summaryCollections').textContent = selectedCols.length;
  document.getElementById('summaryProducts').textContent = totalProducts;
  document.getElementById('summaryVariants').textContent = totalVariants;
}

function getSelectedCollections() {
  return [...document.querySelectorAll('.pdf-col-check:checked')].map(cb => cb.dataset.colId);
}

async function loadPdfHistory() {
  try {
    const res = await fetch('/api/pdfs');
    const data = await res.json();
    const container = document.getElementById('pdfHistoryContainer');
    if (!data.ok || data.pdfs.length === 0) {
      container.innerHTML = '<p class="text-muted">No hay PDFs generados aún.</p>';
      return;
    }
    container.innerHTML = data.pdfs.map(pdf => `
      <div class="pdf-history-item">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--danger);flex-shrink:0">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="pdf-history-name">${escHtml(pdf.name)}</span>
        <span class="pdf-history-date">${new Date(pdf.date).toLocaleDateString('es-CO')}</span>
        <a href="/api/pdfs/${encodeURIComponent(pdf.name)}" class="btn btn--secondary" style="padding:4px 10px;font-size:12px;" download>
          Descargar
        </a>
      </div>`).join('');
  } catch (e) {
    console.error('Error cargando historial:', e);
  }
}

/* ─── Generación de PDF ──────────────────────────────────────────────────── */
document.getElementById('generatePdfBtn').addEventListener('click', generatePdf);

async function generatePdf() {
  const btn = document.getElementById('generatePdfBtn');
  const generatingMsg = document.getElementById('pdfGeneratingMsg');
  const resultMsg = document.getElementById('pdfResultMsg');
  const selectedCollections = getSelectedCollections();

  if (selectedCollections.length === 0) {
    showMsgPersist(resultMsg, 'Selecciona al menos una colección para incluir en el PDF.', 'error');
    return;
  }

  btn.disabled = true;
  generatingMsg.style.display = 'flex';
  resultMsg.style.display = 'none';

  try {
    const res = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedCollections }),
    });

    generatingMsg.style.display = 'none';

    if (res.ok && res.headers.get('content-type')?.includes('application/pdf')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().split('T')[0];
      a.href = url;
      a.download = `listado-distribuidor-${today}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showMsgPersist(resultMsg, 'PDF generado y descargado correctamente.', 'success');
      loadPdfHistory();
    } else {
      const data = await res.json().catch(() => ({}));
      showMsgPersist(resultMsg, data.error || 'Error al generar el PDF.', 'error');
    }
  } catch (e) {
    generatingMsg.style.display = 'none';
    showMsgPersist(resultMsg, 'Sin conexión con el servidor.', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ─── Escaping ───────────────────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ─── Init ───────────────────────────────────────────────────────────────── */
(async function init() {
  await loadConfig();
  // Restaurar colecciones en caché del servidor para que el PDF tab funcione
  // sin necesidad de re-sincronizar después de recargar la página
  if (state.config.collectionsCache && state.config.collectionsCache.length > 0) {
    state.collections = state.config.collectionsCache;
    renderCollections(state.collections);
    renderMargins(state.collections);
    updateHiddenBadge();
    const dot = document.getElementById('statusDot');
    const statusText = document.getElementById('syncStatusText');
    if (dot) dot.className = 'status-dot synced';
    if (statusText && state.config.lastSync) {
      statusText.textContent = `Última sync: ${new Date(state.config.lastSync).toLocaleString('es-CO')}`;
    }
  }
  refreshPdfTab();
  loadPdfHistory();
})();
