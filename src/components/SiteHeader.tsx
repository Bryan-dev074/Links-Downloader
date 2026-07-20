export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="brand-lockup" aria-label="Links Downloader">
        <span className="brand-shield" aria-hidden="true">L</span>
        <span className="brand-copy">
          <span className="brand-name">Links Downloader</span>
          <span className="brand-tagline">La bóveda de tus enlaces</span>
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
