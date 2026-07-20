import type { FormEvent } from 'react'
import { PixelIcon } from './PixelIcon'

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
      <label className="field-label" htmlFor="tiktok-url">
        Enlace de TikTok
        <span className="field-hint">Video público</span>
      </label>
      <div className={`input-shell${error ? ' has-error' : ''}`}>
        <PixelIcon className="input-icon" name="link" />
        <input
          id="tiktok-url"
          className="link-input"
          type="url"
          value={input}
          onChange={(event) => onInputChange(event.currentTarget.value)}
          placeholder="https://www.tiktok.com/@usuario/video/…"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="go"
          inputMode="url"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'link-error' : 'form-privacy'}
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
          {loading ? 'Buscando la mejor calidad…' : 'Buscar video'}
        </span>
      </button>
      {loading ? (
        <div className="loading-track" aria-hidden="true">
          {LOADER_SEGMENTS.map((segment) => <span key={segment} />)}
        </div>
      ) : null}
      <p id="form-privacy" className="trust-row">
        <span>Sin registro</span>
        <span className="trust-divider" aria-hidden="true" />
        <span>No guardamos el enlace</span>
        <span className="trust-divider" aria-hidden="true" />
        <span>Optimizado para móvil</span>
      </p>
    </form>
  )
}
