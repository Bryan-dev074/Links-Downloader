# Links Downloader

Una experiencia web **mobile-first** para resolver y descargar videos de TikTok con la mejor calidad disponible, presentada con una interfaz oscura inspirada en los RPG de pixel art.

> [!IMPORTANT]
> TikTok es el primer y, por ahora, único proveedor compatible. El nombre del proyecto deja espacio para incorporar otras plataformas en el futuro, pero el roadmap no constituye una promesa de disponibilidad ni de fechas.

## Qué ofrece

- Flujo directo: pegar un enlace, resolver el video y elegir una descarga.
- Opción de mejor calidad destacada antes que las alternativas.
- Experiencia adaptable, diseñada principalmente para teléfonos.
- Interfaz temática con animaciones y estados visuales durante la resolución.
- Despliegue estático: no requiere una base de datos ni un servidor propio en esta versión.

La aplicación solicita siempre la mejor variante que el servicio de resolución declare disponible. La calidad final depende del video original, de las variantes expuestas por TikTok y de la respuesta del proveedor externo; por eso no puede garantizarse una resolución, tasa de bits o disponibilidad concreta.

## Cómo funciona

La primera versión consulta la API pública de **TikWM** directamente desde el navegador. No usa claves, cuentas ni un backend propio. Cuando la resolución no está disponible, la interfaz se degrada de forma segura y permite volver al enlace original de TikTok.

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

La aplicación sigue siendo completamente estática: Vercel sirve el frontend y la consulta a TikWM ocurre directamente desde el navegador. No uses Vercel Functions para hacer scraping o retransmitir archivos multimedia. Una integración futura con secretos deberá usar un proveedor autorizado y un alojamiento cuyo contrato permita expresamente esa carga. Nunca incluyas claves privadas en variables `VITE_*`, porque Vite las expone en el bundle del cliente.

## GitHub Pages opcional

La compilación usa rutas relativas (`base: "./"`), así que el mismo `dist/` también puede publicarse dentro de una ruta de proyecto de GitHub Pages. GitHub Pages queda como alternativa manual y no es necesario para la versión de producción actual.

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
