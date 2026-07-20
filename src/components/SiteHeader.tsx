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
      <span className="provider-badge">
        <span className="provider-badge-dot" aria-hidden="true" />
        TikTok activo
      </span>
    </header>
  )
}
