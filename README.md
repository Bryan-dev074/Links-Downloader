# Links Downloader

Una experiencia web **mobile-first** para descargar contenido público de TikTok e Instagram con la mejor calidad que cada plataforma expone, presentada con una interfaz oscura inspirada en los RPG de pixel art.

> [!IMPORTANT]
> Instagram necesita la Vercel Function incluida en el repositorio; no funciona desde un alojamiento puramente estático como GitHub Pages. Se admiten publicaciones, Reels, fotos y carruseles públicos. Historias, contenido privado y publicaciones que exijan iniciar sesión quedan fuera de alcance.

## Qué ofrece

- Flujo directo: pegar un enlace, resolver el video y elegir una descarga.
- En TikTok compara la variante fuente, HD y compatible; la de mayor resolución real queda arriba.
- En Instagram toma el video o la imagen de mayor resolución declarada por la publicación, incluidos carruseles mixtos.
- Muestra resolución, codec, FPS, bitrate estimado y tamaño cuando están disponibles.
- Experiencia adaptable, diseñada principalmente para teléfonos.
- Interfaz temática con animaciones y estados visuales durante la resolución.
- Despliegue en Vercel sin base de datos; una función acotada respalda la lectura de metadatos.

La aplicación no recomprime, remultiplexa ni reescala el contenido. En TikTok inspecciona los MP4 disponibles y prioriza resolución; si dos variantes tienen la misma resolución, usa FPS, origen y bitrate estimado para desempatar. En Instagram selecciona el candidato progresivo de mayor resolución que la propia página pública declara. La calidad final siempre depende del archivo publicado y de lo que la plataforma entregue en ese momento, por lo que no puede garantizarse una resolución concreta.

## Cómo funciona

Para TikTok, la aplicación consulta desde el navegador tanto el endpoint HD como el flujo de tareas de calidad fuente de **TikWM**. Después lee metadatos del contenedor MP4 mediante solicitudes parciales o `preload="metadata"`, elige la mejor variante comprobada y conserva las alternativas útiles. Una Vercel Function restringida a `v16.tokcdn.com` puede leer como máximo 1,5 MiB del MP4 para comprobar resolución, codec y FPS cuando el navegador no entiende el codec. Si el flujo fuente falla, vuelve automáticamente a HD/compatible.

Para Instagram, otra función valida primero el dominio y la ruta, descarga como máximo 4 MiB del documento público y localiza los metadatos que Instagram incluye para visitantes sin sesión. Selecciona el candidato original con más resolución, acepta únicamente URLs HTTPS de los CDN de Meta y entrega esa URL firmada al navegador. Si Instagram exige iniciar sesión a la IP de Vercel, usa como respaldo el endpoint público fijo de `@jerrycoder/instagram-api`; su respuesta queda limitada en tamaño y cada archivo se vuelve a validar por host, ruta, MIME y una lectura parcial. La función no retransmite ni almacena el archivo multimedia.

Ambas integraciones son no oficiales y frágiles: TikWM o Instagram pueden cambiar su respuesta, limitar solicitudes o dejar de servir determinado contenido sin aviso. Links Downloader no controla su disponibilidad ni está afiliado a TikWM, TikTok, Instagram o Meta.

## Desarrollo local

Requisitos:

- Node.js 24
- pnpm

Instala las dependencias y levanta el entorno completo (frontend y Functions):

```bash
pnpm install
vercel link
vercel dev
```

`pnpm dev` también sirve para trabajar únicamente en la interfaz, pero no ejecuta `/api/instagram`.

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

Vercel sirve el frontend y dos funciones acotadas: una comprueba metadatos MP4 de TikTok y otra resuelve publicaciones públicas de Instagram. Ambas validan estrictamente hosts, rutas, redirecciones, tipos y tamaños de respuesta; ninguna funciona como proxy del archivo multimedia. La descarga se realiza desde el navegador contra el CDN correspondiente. Nunca incluyas claves privadas en variables `VITE_*`, porque Vite las expone en el bundle del cliente.

## GitHub Pages opcional

La compilación usa rutas relativas (`base: "./"`), así que el mismo `dist/` también puede publicarse dentro de una ruta de proyecto de GitHub Pages. Allí TikTok conserva su flujo del navegador, aunque sin el respaldo de metadatos del servidor. Instagram no puede resolverse porque GitHub Pages no ejecuta `/api/instagram`; por eso Vercel es el alojamiento de producción requerido para el soporte completo.

## Límites y uso responsable

- Descarga únicamente contenido propio o para el que tengas permiso.
- Respeta derechos de autor, privacidad, legislación aplicable y los términos de cada plataforma.
- No uses la aplicación para recolección masiva, evasión de controles o redistribución no autorizada.
- No se garantiza disponibilidad continua, ausencia de marcas de agua, compatibilidad con todos los enlaces ni una calidad específica.
- La automatización de Instagram puede estar limitada por sus condiciones y controles técnicos; usa esta herramienta únicamente sobre contenido público propio o con autorización.
- TikTok, Instagram, Sonic, Shadow y las demás marcas mencionadas pertenecen a sus respectivos titulares.
- Antes de redistribuir el proyecto, verifica que cuentas con permiso o una licencia compatible para cada GIF, icono y recurso visual incluido.

## Recurso de marca

El portal animado de la cabecera procede de [Pixel Magic Effects de Foozle](https://foozlecc.itch.io/pixel-magic-sprite-effects) y se distribuye bajo licencia [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). El GIF se guarda localmente y se adapta a un bucle ambiental continuo para no depender de recursos externos ni introducir parpadeos en producción.

## Roadmap orientativo

- Reforzar la accesibilidad y el feedback ante errores del proveedor.
- Evaluar proveedores autorizados e intercambiables si alguna integración actual deja de ser adecuada.
- Añadir plataformas solo cuando exista una integración técnica y legalmente sostenible.
- Explorar instalación como PWA y mejoras de rendimiento en redes móviles.

El roadmap expresa líneas de exploración y puede cambiar según las limitaciones técnicas y de las plataformas.

## Repositorio

[Bryan-dev074/Links-Downloader](https://github.com/Bryan-dev074/Links-Downloader)
