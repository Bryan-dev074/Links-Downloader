export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="brand-lockup" aria-label="Links Downloader">
        <span className="brand-portal" aria-hidden="true">
          <span className="brand-portal-orbit" />
          <svg className="brand-portal-mark" viewBox="0 0 32 32" shapeRendering="crispEdges">
            <path
              className="brand-portal-frame"
              fillRule="evenodd"
              d="M10 2h12v3h4v4h3v14h-3v4h-4v3H10v-3H6v-4H3V9h3V5h4V2Zm2 6h8v2h3v4h2v6h-2v3h-3v2h-8v-2H9v-3H7v-6h2v-4h3V8Z"
            />
            <path className="brand-portal-arrow-shadow" d="M14 9h5v9h5v4h-3v3h-3v3h-5v-3h-3v-3H8v-4h6V9Z" />
            <path className="brand-portal-arrow" d="M14 8h4v10h5v3h-3v3h-3v3h-4v-3h-3v-3H8v-3h6V8Z" />
          </svg>
          <span className="brand-portal-spark" />
        </span>
        <span className="brand-copy">
          <span className="brand-name">Links Downloader</span>
          <span className="brand-tagline">Portal de máxima calidad</span>
        </span>
      </div>
      <a
        className="creator-badge"
        href="https://github.com/Bryan-dev074"
        target="_blank"
        rel="noreferrer"
        aria-label="Creado por Bryan-dev074 · Abrir perfil de GitHub"
      >
        <span className="creator-badge-rune" aria-hidden="true" />
        <span className="creator-badge-label">Creado por</span>
        <span className="creator-badge-name">Bryan-dev074</span>
        <span className="creator-badge-shine" aria-hidden="true" />
      </a>
    </header>
  )
}
