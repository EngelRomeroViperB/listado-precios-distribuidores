const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const GENERATED_DIR = path.join(__dirname, 'generated');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'pdf-template.html');

// Crear carpeta generated si no existe
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = {
      shopifyStore: '',
      shopifyToken: '',
      logoUrl: '',
      primaryColor: '#1a56db',
      secondaryColor: '#6875f5',
      currencySymbol: 'COP',
      thousandSeparator: '.',
      footerMessage: 'Precios válidos hasta el 30 de junio de 2025',
      collectionMargins: {},
      hiddenProducts: [],
      hiddenVariants: [],
      hiddenCollections: [],
      lastSync: null,
      pdfHistory: [],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseShopifyError(error) {
  if (!error.response) {
    return 'Sin conexión a internet o no se pudo alcanzar la tienda.';
  }
  const status = error.response.status;
  if (status === 401) return 'Token inválido o vencido. Verifica el Access Token de Shopify.';
  if (status === 403) return 'Acceso denegado. El token no tiene los permisos necesarios (read_products, read_inventory).';
  if (status === 404) return 'Tienda no encontrada. Verifica el nombre de la tienda (ej: mitienda.myshopify.com).';
  if (status === 429) return 'Límite de peticiones de Shopify alcanzado. Intenta de nuevo en unos segundos.';
  return `Error de Shopify (${status}): ${error.response.data?.errors || 'Error desconocido'}`;
}

// ─── Paginación Shopify ──────────────────────────────────────────────────────

function extractNextUrl(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function shopifyGetAll(baseUrl, token, params = {}) {
  const results = [];
  let url = baseUrl;
  const headers = { 'X-Shopify-Access-Token': token };

  const firstUrl = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    firstUrl.searchParams.set(k, v);
  }
  url = firstUrl.toString();

  while (url) {
    const response = await axios.get(url, { headers });
    const data = response.data;
    const keys = Object.keys(data);
    if (keys.length > 0) {
      const items = data[keys[0]];
      if (Array.isArray(items)) results.push(...items);
    }
    url = extractNextUrl(response.headers['link']);
  }
  return results;
}

// ─── Batching inventory items ────────────────────────────────────────────────

async function getInventoryCosts(inventoryItemIds, baseUrl, token) {
  const headers = { 'X-Shopify-Access-Token': token };
  const costMap = {};
  const chunks = [];
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    chunks.push(inventoryItemIds.slice(i, i + 50));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const url = `${baseUrl}/admin/api/2024-01/inventory_items.json?ids=${chunk.join(',')}&limit=50`;
    try {
      const response = await axios.get(url, { headers });
      for (const item of response.data.inventory_items) {
        costMap[item.id] = item.cost != null ? parseFloat(item.cost) : null;
      }
    } catch (err) {
      console.error(`Error en batch de inventory_items: ${err.message}`);
    }
    if (i < chunks.length - 1) {
      await sleep(500);
    }
  }
  return costMap;
}

// ─── Endpoints de Configuración ─────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  try {
    const config = readConfig();
    const safeConfig = { ...config };
    res.json({ ok: true, config: safeConfig });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al leer la configuración.' });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const current = readConfig();
    const updated = { ...current, ...req.body };
    writeConfig(updated);
    res.json({ ok: true, message: 'Configuración guardada correctamente.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al guardar la configuración.' });
  }
});

// ─── Sincronización con Shopify ──────────────────────────────────────────────

app.get('/api/sync', async (req, res) => {
  const config = readConfig();
  const { shopifyStore, shopifyToken } = config;

  if (!shopifyStore || !shopifyToken) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan credenciales. Configura el nombre de la tienda y el token en la pestaña Configuración.',
    });
  }

  const baseUrl = `https://${shopifyStore}`;

  try {
    // 1. Traer TODOS los productos (para costos y datos base)
    const allProducts = await shopifyGetAll(`${baseUrl}/admin/api/2024-01/products.json`, shopifyToken, { limit: 250 });

    // 2. Recolectar inventory_item_ids y obtener costos
    const allInventoryIds = [];
    for (const product of allProducts) {
      for (const variant of product.variants) {
        if (variant.inventory_item_id) {
          allInventoryIds.push(variant.inventory_item_id);
        }
      }
    }
    const costMap = await getInventoryCosts(allInventoryIds, baseUrl, shopifyToken);

    // Mapa global de productos enriquecidos (id → producto)
    const productMap = {};
    for (const product of allProducts) {
      productMap[product.id] = {
        id: product.id,
        title: product.title,
        image: product.image ? product.image.src : null,
        variants: product.variants.map((v) => ({
          id: v.id,
          title: v.title,
          price: parseFloat(v.price) || 0,
          inventoryItemId: v.inventory_item_id,
          cost: costMap[v.inventory_item_id] !== undefined ? costMap[v.inventory_item_id] : null,
          image: v.image_id
            ? (product.images.find((img) => img.id === v.image_id) || {}).src || product.image?.src || null
            : product.image?.src || null,
        })),
      };
    }

    // 3. Traer colecciones (custom + smart)
    const [customCollections, smartCollections] = await Promise.all([
      shopifyGetAll(`${baseUrl}/admin/api/2024-01/custom_collections.json`, shopifyToken, { limit: 250 }),
      shopifyGetAll(`${baseUrl}/admin/api/2024-01/smart_collections.json`, shopifyToken, { limit: 250 }),
    ]);
    const allCollections = [...customCollections, ...smartCollections];
    console.log(`  → ${allCollections.length} colecciones encontradas (${customCollections.length} custom, ${smartCollections.length} smart)`);

    // 4. Para cada colección, pedir sus productos con ?collection_id=X
    //    Esto funciona tanto para custom como para smart collections.
    //    Para evitar duplicados: un producto solo aparece en la primera
    //    colección en que se encuentre.
    const assignedProductIds = new Set();
    const result = [];

    for (const col of allCollections) {
      await sleep(300); // respetar rate limit
      const colProducts = await shopifyGetAll(
        `${baseUrl}/admin/api/2024-01/products.json`,
        shopifyToken,
        { limit: 250, collection_id: col.id }
      );

      // Solo incluir productos no asignados aún
      const uniqueProducts = colProducts
        .filter((p) => !assignedProductIds.has(p.id))
        .map((p) => {
          assignedProductIds.add(p.id);
          return productMap[p.id] || {
            id: p.id,
            title: p.title,
            image: p.image ? p.image.src : null,
            variants: [],
          };
        });

      if (uniqueProducts.length > 0) {
        result.push({
          id: col.id,
          title: col.title,
          products: uniqueProducts,
        });
      }
      console.log(`  → Colección "${col.title}": ${uniqueProducts.length} productos únicos`);
    }

    // 5. Productos sin ninguna colección
    const uncategorizedProducts = allProducts
      .filter((p) => !assignedProductIds.has(p.id))
      .map((p) => productMap[p.id]);

    if (uncategorizedProducts.length > 0) {
      result.push({
        id: 'uncategorized',
        title: 'Sin colección',
        products: uncategorizedProducts,
      });
    }

    console.log(`  → Total: ${result.length} colecciones, ${allProducts.length} productos`);

    // Actualizar lastSync y caché de colecciones en config
    const updatedConfig = readConfig();
    updatedConfig.lastSync = new Date().toISOString();
    updatedConfig.collectionsCache = result; // ← caché persistente
    // Asegurar que todas las colecciones tengan margen definido
    for (const col of result) {
      if (updatedConfig.collectionMargins[col.id] === undefined) {
        updatedConfig.collectionMargins[col.id] = 0;
      }
    }
    writeConfig(updatedConfig);

    res.json({
      ok: true,
      collections: result,
      totalProducts: allProducts.length,
      totalVariants: allProducts.reduce((sum, p) => sum + p.variants.length, 0),
      lastSync: updatedConfig.lastSync,
    });
  } catch (err) {
    console.error('Error en sincronización:', err.message);
    const errorMsg = parseShopifyError(err);
    res.status(500).json({ ok: false, error: errorMsg });
  }
});

// ─── Generación de PDF ───────────────────────────────────────────────────────

app.post('/api/generate-pdf', async (req, res) => {
  const { selectedCollections } = req.body;
  const config = readConfig();

  // Usar caché del servidor en lugar de datos enviados por el frontend
  const collections = config.collectionsCache || [];

  if (!collections || collections.length === 0) {
    return res.status(400).json({ ok: false, error: 'No hay datos de productos. Ve a la pestaña Productos y sincroniza primero.' });
  }

  try {
    const templateHtml = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    // Filtrar colecciones seleccionadas y productos visibles
    const filteredCollections = collections
      .filter((col) => {
        if (selectedCollections && selectedCollections.length > 0) {
          return selectedCollections.includes(String(col.id));
        }
        return !config.hiddenCollections.includes(String(col.id));
      })
      .map((col) => ({
        ...col,
        margin: config.collectionMargins[col.id] !== undefined ? parseFloat(config.collectionMargins[col.id]) : 0,
        products: col.products
          .filter((p) => !config.hiddenProducts.includes(String(p.id)))
          .map((p) => ({
            ...p,
            variants: p.variants.filter((v) => !config.hiddenVariants.includes(String(v.id))),
          }))
          .filter((p) => p.variants.length > 0),
      }))
      .filter((col) => col.products.length > 0);

    const pdfData = {
      storeName: config.shopifyStore ? config.shopifyStore.replace('.myshopify.com', '') : 'Mi Tienda',
      logoUrl: config.logoUrl || '',
      primaryColor: config.primaryColor || '#1a56db',
      secondaryColor: config.secondaryColor || '#6875f5',
      currencySymbol: config.currencySymbol || 'COP',
      thousandSeparator: config.thousandSeparator || '.',
      footerMessage: config.footerMessage || '',
      generatedDate: new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' }),
      collections: filteredCollections,
    };

    // Inyectar datos en el template
    const htmlWithData = templateHtml.replace('/*INJECT_DATA*/', `const PDF_DATA = ${JSON.stringify(pdfData)};`);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(htmlWithData, { waitUntil: 'networkidle0' });

    // Esperar a que se rendericen las imágenes
    await sleep(1500);

    const today = new Date().toISOString().split('T')[0];
    const fileName = `listado-distribuidor-${today}.pdf`;
    const filePath = path.join(GENERATED_DIR, fileName);

    await page.pdf({
      path: filePath,
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    await browser.close();

    // Guardar en historial
    const updatedConfig = readConfig();
    if (!updatedConfig.pdfHistory) updatedConfig.pdfHistory = [];
    updatedConfig.pdfHistory.unshift({ name: fileName, date: new Date().toISOString() });
    updatedConfig.pdfHistory = updatedConfig.pdfHistory.slice(0, 20); // Máximo 20 entradas
    writeConfig(updatedConfig);

    res.download(filePath, fileName);
  } catch (err) {
    console.error('Error al generar PDF:', err.message);
    res.status(500).json({ ok: false, error: `Error al generar el PDF: ${err.message}` });
  }
});

// ─── Lista de PDFs generados ─────────────────────────────────────────────────

app.get('/api/pdfs', (req, res) => {
  try {
    const config = readConfig();
    const history = config.pdfHistory || [];
    const available = history.filter((entry) => {
      const filePath = path.join(GENERATED_DIR, entry.name);
      return fs.existsSync(filePath);
    });
    res.json({ ok: true, pdfs: available });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener el historial de PDFs.' });
  }
});

app.get('/api/pdfs/:filename', (req, res) => {
  const filePath = path.join(GENERATED_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'Archivo no encontrado.' });
  }
  res.download(filePath);
});

// ─── Inicio del servidor ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📁 PDFs generados en: ${GENERATED_DIR}`);
  console.log(`⚙️  Configuración en: ${CONFIG_PATH}`);
});
