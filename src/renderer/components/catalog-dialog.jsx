import { useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
import './catalog.css'

export function CatalogDialog({ title, description, label, id, name, icon: Icon, className = '', disabled, onOpenChange, children }) {
  const [open, setOpen] = useState(false)
  const content = useRef(null)
  function toggle(value) {
    setOpen(value)
    onOpenChange?.(value)
  }
  return <Dialog.Root open={open} onOpenChange={toggle}>
    <Dialog.Trigger asChild>
      <Button id={id} type="button" aria-label={label} variant="outline" size="sm" disabled={disabled} className={'catalog-trigger ' + className}>
        {Icon && <Icon aria-hidden="true" />}<span>{name}</span><ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="catalog-overlay" />
      <Dialog.Content ref={content} className="catalog-dialog" onOpenAutoFocus={(event) => {
        const target = content.current?.querySelector('[data-catalog-autofocus], .harness-card[aria-pressed="true"]')
        if (target) { event.preventDefault(); target.focus() }
      }}>
        <header className="catalog-heading">
          <div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
          <Dialog.Close asChild><Button type="button" size="icon-sm" variant="ghost" aria-label="Close picker"><X /></Button></Dialog.Close>
        </header>
        {children(() => toggle(false))}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
