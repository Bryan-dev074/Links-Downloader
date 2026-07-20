import type { FormEvent } from 'react'
import { PixelIcon } from './PixelIcon'
import { TrustSignals } from './TrustSignals'

interface LinkFormProps {
  error?: string
  input: string
  loading: boolean
  onInputChange: (value: string) => void
  onPaste: () => void | Promise<void>
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>
}

const LOADER_SEGMENTS = [
  'segment-01',
  'segment-02',
  'segment-03',
  'segment-04',
  'segment-05',
  'segment-06',
  'segment-07',
  'segment-08',
  'segment-09',
  'segment-10',
  'segment-11',
  'segment-12',
] as const

export function LinkForm({
  error,
  input,
  loading,
  onInputChange,
  onPaste,
  onSubmit,
}: LinkFormProps) {
  return (
    <form className="link-form" onSubmit={onSubmit} noValidate>
      <label className="field-label" htmlFor="media-url">
        Enlace de la publicación
        <span className="field-hint">Contenido público compatible</span>
      </label>
      <p id="link-helper" className="sr-only">
        Pega un enlace público compatible. Actualmente puedes usar enlaces de TikTok e Instagram.
      </p>
      <div className={`input-shell${error ? ' has-error' : ''}${input.trim() ? ' is-filled' : ''}`}>
        <span className="input-beacon" aria-hidden="true">
          <PixelIcon name="clipboard" />
          <span className="input-beacon-packet" />
        </span>
        <input
          id="media-url"
          className="link-input"
          type="url"
          value={input}
          onChange={(event) => onInputChange(event.currentTarget.value)}
          placeholder="Pega tu enlace"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="go"
          inputMode="url"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'link-helper link-error' : 'link-helper'}
          disabled={loading}
        />
        <button className="paste-button" type="button" onClick={onPaste} disabled={loading}>
          Pegar
        </button>
      </div>
      {error ? (
        <p id="link-error" className="error-message" role="alert">
          <span className="error-rune" aria-hidden="true">!</span>
          {error}
        </p>
      ) : null}
      <button className="action-button" type="submit" disabled={loading}>
        <span className="action-button-content">
          {loading ? <span className="loading-glyph" aria-hidden="true" /> : <PixelIcon name="search" />}
          {loading ? 'Buscando la mejor calidad…' : 'Buscar contenido'}
        </span>
      </button>
      {loading ? (
        <div className="loading-track" aria-hidden="true">
          {LOADER_SEGMENTS.map((segment) => <span key={segment} />)}
        </div>
      ) : null}
      <TrustSignals />
    </form>
  )
}
