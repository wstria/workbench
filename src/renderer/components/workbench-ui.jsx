import { useId } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function Page({ title, description, actions, children, variant }) {
  const heading = useId()
  return <section className="work-page" aria-labelledby={heading}>
    <div className="work-inner" data-variant={variant}>
      <header className="work-heading">
        <div><h1 id={heading}>{title}</h1>{description && <p>{description}</p>}</div>
        {actions && <div className="work-actions">{actions}</div>}
      </header>
      {children}
    </div>
  </section>
}

export function SearchField({ label, value, onChange, className = '' }) {
  return (
    <div className={'work-search ' + className}>
      <Search size={15} aria-hidden="true" />
      <Input type="search" aria-label={label} placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

export function Segments({ label, value, onChange, options }) {
  return (
    <div className="work-segments" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <Button key={key} type="button" size="sm" variant="ghost" aria-pressed={value === key} onClick={() => onChange(key)}>
          {text}
        </Button>
      ))}
    </div>
  )
}

export function Empty({ icon: Icon, title, text }) {
  return <div className="work-empty"><Icon size={23} aria-hidden="true" /><strong>{title}</strong>{text && <span>{text}</span>}</div>
}

export function ErrorNotice({ error }) {
  return error && <p role="alert" className="work-error">{String(error.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}</p>
}

export const formatDate = (time) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
