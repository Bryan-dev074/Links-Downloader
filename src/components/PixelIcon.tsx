export type PixelIconName =
  | 'audio'
  | 'bolt'
  | 'clipboard'
  | 'download'
  | 'external'
  | 'gem'
  | 'image'
  | 'link'
  | 'mobile'
  | 'search'
  | 'shield'
  | 'video'

interface PixelIconProps {
  name: PixelIconName
  className?: string
}

export function PixelIcon({ name, className }: PixelIconProps) {
  const commonProps = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'square' as const,
    strokeLinejoin: 'miter' as const,
    shapeRendering: 'crispEdges' as const,
    'aria-hidden': true,
  }

  if (name === 'link') {
    return (
      <svg {...commonProps}>
        <path d="M9 7H6v2H4v6h2v2h5v-2H7v-2h6v-2H7V9h2z" />
        <path d="M15 7h3v2h2v6h-2v2h-5v-2h4v-2h-6v-2h6V9h-2z" />
      </svg>
    )
  }

  if (name === 'search') {
    return (
      <svg {...commonProps}>
        <path d="M5 5h10v2h2v10h-2v2H5v-2H3V7h2z" />
        <path d="M16 16h2v2h2v2h-2l-2-2z" />
      </svg>
    )
  }

  if (name === 'clipboard') {
    return (
      <svg {...commonProps}>
        <path d="M8 4V2h8v2h3v18H5V4h3z" />
        <path d="M8 4h8v3H8z" fill="currentColor" stroke="none" />
        <path d="M11 9h2v6h3l-4 4-4-4h3z" fill="currentColor" stroke="none" />
      </svg>
    )
  }

  if (name === 'bolt') {
    return (
      <svg {...commonProps}>
        <path d="M13 2 5 14h6l-1 8 9-13h-6z" fill="currentColor" stroke="none" />
      </svg>
    )
  }

  if (name === 'shield') {
    return (
      <svg {...commonProps}>
        <path d="M12 2 20 5v7c0 5-3 8-8 10-5-2-8-5-8-10V5z" />
        <path d="m8 12 3 3 5-6" />
      </svg>
    )
  }

  if (name === 'mobile') {
    return (
      <svg {...commonProps}>
        <rect x="6" y="2" width="12" height="20" />
        <path d="M9 5h6M10 18h4" />
      </svg>
    )
  }

  if (name === 'download') {
    return (
      <svg {...commonProps}>
        <path d="M10 3h4v9h4v3h-2v2h-2v2h-4v-2H8v-2H6v-3h4z" />
        <path d="M4 20h16" />
      </svg>
    )
  }

  if (name === 'video') {
    return (
      <svg {...commonProps}>
        <rect x="3" y="5" width="14" height="14" />
        <path d="M17 9h2V7h2v10h-2v-2h-2z" />
        <path d="m8 9 5 3-5 3z" fill="currentColor" stroke="none" />
      </svg>
    )
  }

  if (name === 'audio') {
    return (
      <svg {...commonProps}>
        <path d="M9 5h9v3H12v9H9z" />
        <rect x="4" y="15" width="6" height="4" />
        <rect x="13" y="15" width="6" height="4" />
      </svg>
    )
  }

  if (name === 'image') {
    return (
      <svg {...commonProps}>
        <rect x="3" y="4" width="18" height="16" />
        <rect x="7" y="8" width="3" height="3" fill="currentColor" stroke="none" />
        <path d="m5 18 5-5 3 3 2-2 4 4" />
      </svg>
    )
  }

  if (name === 'gem') {
    return (
      <svg {...commonProps}>
        <path d="M8 3h8l5 6-9 12L3 9z" />
        <path d="m3 9 5-3 4 3 4-3 5 3M8 3l4 6 4-6M12 9v12" />
      </svg>
    )
  }

  if (name === 'external') {
    return (
      <svg {...commonProps}>
        <path d="M13 4h7v7M20 4l-9 9" />
        <path d="M17 14v6H4V7h6" />
      </svg>
    )
  }

  return null
}
