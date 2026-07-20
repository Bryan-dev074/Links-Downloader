# Links Downloader

Una experiencia web **mobile-first** para resolver y descargar videos de TikTok con la mejor calidad disponible, presentada con una interfaz oscura inspirada en los RPG de pixel art.

> [!IMPORTANT]
> TikTok es el primer y, por ahora, único proveedor compatible. El nombre del proyecto deja espacio para incorporar otras plataformas en el futuro, pero el roadmap no constituye una promesa de disponibilidad ni de fechas.

## Qué ofrece

- Flujo directo: pegar un enlace, resolver el video y elegir una descarga.
- Compara la variante fuente, HD y compatible; la de mayor resolución real queda arriba.
- Muestra resolución, codec, FPS, bitrate estimado y tamaño cuando están disponibles.
- Experiencia adaptable, diseñada principalmente para teléfonos.
- Interfaz temática con animaciones y estados visuales durante la resolución.
- Despliegue en Vercel sin base de datos; una función acotada respalda la lectura de metadatos.

La aplicación no recomprime ni reescala el contenido. Inspecciona los MP4 disponibles y prioriza resolución; si dos variantes tienen la misma resolución, usa FPS, origen y bitrate estimado para desempatar. La calidad final sigue dependiendo del archivo publicado en TikTok y de lo que exponga el proveedor externo, por lo que no puede garantizarse una resolución o disponibilidad concreta.

## Cómo funciona

La aplicación consulta desde el navegador tanto el endpoint HD como el flujo de tareas de calidad fuente de **TikWM**. Después lee metadatos del contenedor MP4 mediante solicitudes parciales o `preload="metadata"`, elige la mejor variante comprobada y conserva las alternativas útiles. Una Vercel Function restringida a `v16.tokcdn.com` puede leer como máximo 1,5 MiB del MP4 para comprobar resolución, codec y FPS cuando el navegador no entiende el codec. No retransmite el video ni modifica sus bytes. Si el flujo fuente falla, vuelve automáticamente a HD/compatible.

TikWM es un servicio externo y no oficial. Puede cambiar, limitar solicitudes, sufrir interrupciones o dejar de admitir peticiones desde el navegador sin previo aviso. Links Downloader no controla su disponibilidad ni está afiliado con TikWM o TikTok.

## Desarrollo local

Requisitos:

- Node.js 24
- pnpm

Instala las dependencias y levanta el entorno de desarrollo:

```bash
pnpm install
pnpm dev
```

Para validar la versión de producción:

```bash
pnpm build
pnpm preview
```

El resultado compilado se genera en `dist/`.

## Publicación en Vercel

La versión de producción está publicada en:

**https://links-downloader.vercel.app/**

El proyecto de Vercel está conectado al repositorio de GitHub, por lo que cada cambio enviado a `main` genera un nuevo despliegue automáticamente. La configuración detectada es:

- **Build Command:** `pnpm build`
- **Output Directory:** `dist`
- **Node.js:** 24

Vercel sirve el frontend y una función mínima de metadatos; la consulta a TikWM y la descarga ocurren directamente desde el navegador. La función rechaza otros hosts, redirecciones y respuestas completas para que no se convierta en un proxy multimedia. Una integración futura con secretos deberá usar un proveedor autorizado y un alojamiento cuyo contrato permita expresamente esa carga. Nunca incluyas claves privadas en variables `VITE_*`, porque Vite las expone en el bundle del cliente.

## GitHub Pages opcional

La compilación usa rutas relativas (`base: "./"`), así que el mismo `dist/` también puede publicarse dentro de una ruta de proyecto de GitHub Pages. Allí seguirá funcionando la inspección directa del navegador, pero no estará disponible el respaldo de metadatos de Vercel para codecs que el dispositivo no pueda leer; por eso Vercel es la opción de producción recomendada.

## Límites y uso responsable

- Descarga únicamente contenido propio o para el que tengas permiso.
- Respeta derechos de autor, privacidad, legislación aplicable y los términos de cada plataforma.
- No uses la aplicación para recolección masiva, evasión de controles o redistribución no autorizada.
- No se garantiza disponibilidad continua, ausencia de marcas de agua, compatibilidad con todos los enlaces ni una calidad específica.
- TikTok y las demás marcas mencionadas pertenecen a sus respectivos titulares.
- Antes de redistribuir el proyecto, verifica que cuentas con permiso o una licencia compatible para cada GIF, icono y recurso visual incluido.

## Roadmap orientativo

- Reforzar la accesibilidad y el feedback ante errores del proveedor.
- Evaluar un proveedor autorizado e intercambiable si la API pública deja de ser adecuada.
- Añadir proveedores adicionales solo cuando exista una integración técnica y legalmente sostenible.
- Explorar instalación como PWA y mejoras de rendimiento en redes móviles.

El roadmap expresa líneas de exploración y puede cambiar según las limitaciones técnicas y de las plataformas.

## Repositorio

[Bryan-dev074/Links-Downloader](https://github.com/Bryan-dev074/Links-Downloader)
