import { useEffect, useState } from 'react'

const greetings = [
  'What are we working on?',
  'What would you like to make?',
  'Where should we start?',
  'What’s on your mind?',
  'What are we building today?',
  'What would you like to tackle?',
]

const reducedMotion = '(prefers-reduced-motion: reduce)'

export function WelcomeGreeting({ tabId, visible, animate }) {
  const greeting = greetings[(tabId - 1) % greetings.length]
  const [revealed, setRevealed] = useState(() => window.matchMedia(reducedMotion).matches ? greeting.length : 0)

  useEffect(() => {
    const motion = window.matchMedia(reducedMotion)
    const finish = () => { if (motion.matches) setRevealed(greeting.length) }
    finish()
    motion.addEventListener('change', finish)
    return () => motion.removeEventListener('change', finish)
  }, [greeting])

  useEffect(() => {
    if (!visible || !animate || revealed >= greeting.length) return
    const timer = setTimeout(() => setRevealed(revealed + 1), 26)
    return () => clearTimeout(timer)
  }, [visible, animate, greeting, revealed])

  const count = animate ? revealed : greeting.length
  return (
    <h1 aria-label={greeting}>
      <span aria-hidden="true">
        {greeting.slice(0, count)}
        {count < greeting.length && <><span className="greeting-caret" /><span className="greeting-untyped">{greeting.slice(count)}</span></>}
      </span>
    </h1>
  )
}
