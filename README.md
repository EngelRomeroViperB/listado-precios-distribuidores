# Listado de Precios para Distribuidores

Aplicación web local que se conecta a tu tienda Shopify para generar listados de precios en PDF para distribuidores.

---

## Requisitos

- **Node.js 18 o superior** — [Descargar aquí](https://nodejs.org/)
- Acceso a una tienda Shopify con una **Custom App** configurada

---

## Instalación

```bash
# 1. Clona el repositorio
git clone https://github.com/EngelRomeroViperB/listado-precios-distribuidores.git
cd listado-precios-distribuidores

# 2. Instala las dependencias
npm install

# 3. Crea tu archivo de configuración (ver sección Configuración)
# El servidor crea un config.json vacío automáticamente al iniciar

# 4. Inicia el servidor
node server.js
```

Abre tu navegador en **http://localhost:3000**

---

## Cómo obtener el token de Shopify (paso a paso)

### 1. Crear una Custom App en Shopify

1. Inicia sesión en tu panel de administración de Shopify
2. Ve a **Configuración** → **Aplicaciones y canales de ventas**
3. Haz clic en **Desarrollar aplicaciones** (arriba a la derecha)
4. Haz clic en **Crear una aplicación**
5. Asigna un nombre (ej: "Listado de Precios Distribuidores")
6. Haz clic en **Configurar ámbitos de la API de Admin**

### 2. Asignar permisos necesarios

En la sección **API de Admin**, habilita los siguientes permisos de lectura:

| Permiso | Para qué se usa |
|---|---|
| `read_products` | Leer productos, variantes y colecciones |
| `read_inventory` | Leer el costo por ítem (`cost_per_item`) |

Guarda los cambios.

### 3. Instalar la app y obtener el token

1. Ve a la pestaña **Credenciales de la API**
2. Haz clic en **Instalar aplicación**
3. Copia el **Admin API access token** (solo se muestra una vez)
4. Guárdalo en un lugar seguro

### 4. Configurar la aplicación

1. Abre la app en http://localhost:3000
2. Ve a la pestaña **Configuración**
3. Ingresa:
   - **Nombre de la tienda**: `mitienda.myshopify.com`
   - **Token**: el token copiado en el paso anterior
4. Haz clic en **Guardar configuración**
5. Ve a la pestaña **Productos** y haz clic en **Sincronizar productos**

---

## Uso

### Pestaña 1 — Configuración

- Ingresa las credenciales de Shopify (tienda + token)
- Personaliza el logo, colores de marca, moneda y mensaje del pie de página
- Configura el **porcentaje de margen por colección**: este porcentaje se aplica sobre el costo de cada variante para calcular el precio distribuidor
  - **Fórmula**: `Precio distribuidor = Costo × (1 + % / 100)`

### Pestaña 2 — Productos

- Haz clic en **Sincronizar productos** para cargar todos los datos desde Shopify
- Los productos aparecen agrupados por colección
- Usa los **toggles** para ocultar/mostrar productos o variantes individuales en el PDF
- Los productos sin costo registrado aparecen marcados en rojo
- Usa la **barra de búsqueda** para filtrar rápidamente

### Pestaña 3 — Generar PDF

- Selecciona las colecciones que deseas incluir
- Revisa el resumen de productos y variantes que se incluirán
- Haz clic en **Generar y descargar PDF** para crear el archivo
- El PDF se descarga automáticamente con nombre `listado-distribuidor-YYYY-MM-DD.pdf`
- El historial de PDFs generados aparece en la parte inferior

---

## Estructura del proyecto

```
listado-precios/
├── server.js              ← Servidor Express + lógica Shopify + generación PDF
├── config.json            ← Configuración local (NO incluido en el repo)
├── package.json
├── .gitignore
├── public/
│   ├── index.html         ← Interfaz web (3 pestañas)
│   ├── style.css          ← Estilos
│   └── app.js             ← Lógica frontend
├── templates/
│   └── pdf-template.html  ← Template HTML para Puppeteer
└── generated/             ← PDFs generados (NO incluido en el repo)
```

---

## Seguridad — Nota importante

> **`config.json` NO está incluido en el repositorio** y nunca debe subirse a GitHub.
>
> Este archivo contiene tu Admin API Access Token de Shopify, que es equivalente a una contraseña de administrador. Si se expone, un tercero podría leer toda la información de tu tienda.
>
> El archivo `.gitignore` ya está configurado para excluirlo automáticamente. La primera vez que instales el proyecto, el servidor creará un `config.json` vacío automáticamente. Debes ingresar tus credenciales desde la interfaz web (Pestaña Configuración) o editarlo manualmente.

---

## Solución de problemas

| Error | Causa probable | Solución |
|---|---|---|
| "Token inválido o vencido" | El token fue regenerado o no tiene permisos | Genera un nuevo token con los permisos correctos |
| "Tienda no encontrada" | El nombre de la tienda está mal escrito | Verifica que incluya `.myshopify.com` |
| "Sin conexión a internet" | El servidor no puede llegar a Shopify | Verifica tu conexión y que la tienda esté activa |
| "Error al generar el PDF" | Problema con Puppeteer | Ejecuta `npm install` de nuevo para reinstalar Puppeteer |

---

## Licencia. no hay necesidad de desplegar 

MIT
