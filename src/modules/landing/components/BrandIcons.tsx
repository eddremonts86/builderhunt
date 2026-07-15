import * as React from 'react'

/* Brand mark inline SVGs — lucide-react 1.x doesn't ship brand icons */

export function GithubIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55 0-.27-.01-1.16-.02-2.1-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.13 0 .3.21.66.79.55C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
    </svg>
  )
}

export function RedditIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.74a1.41 1.41 0 0 1 1.39 1.42 1.41 1.41 0 0 1-1.39 1.41 1.41 1.41 0 0 1-1.4-1.41 1.41 1.41 0 0 1 1.4-1.42zM12 5.07c2.85 0 5.32 1.5 6.61 3.69.51-.1 1.07-.16 1.61-.16.41 0 .82.04 1.22.11-.04.07-.08.14-.12.21-.42.7-.96 1.32-1.6 1.84.04.21.06.43.06.65 0 3.13-3.5 5.66-7.81 5.66-4.32 0-7.81-2.53-7.81-5.66 0-.22.02-.44.06-.65a6.42 6.42 0 0 1-1.6-1.84c-.04-.07-.08-.14-.12-.21.4-.07.81-.11 1.22-.11.54 0 1.1.06 1.61.16C6.68 6.57 9.15 5.07 12 5.07zm-3.05 5.3a1.49 1.49 0 0 0-1.49 1.5 1.49 1.49 0 0 0 1.49 1.5 1.49 1.49 0 0 0 1.49-1.5 1.49 1.49 0 0 0-1.49-1.5zm6.1 0a1.49 1.49 0 0 0-1.49 1.5 1.49 1.49 0 0 0 1.49 1.5 1.49 1.49 0 0 0 1.49-1.5 1.49 1.49 0 0 0-1.49-1.5zm-3.05 3.27c-.6 0-1.46.34-2.41 1.12-.1.08-.13.22-.06.34.07.13.22.17.34.1.79-.65 1.59-1 2.13-1 .54 0 1.34.35 2.13 1 .12.07.27.03.34-.1.07-.12.04-.26-.06-.34-.95-.78-1.81-1.12-2.41-1.12z"/>
    </svg>
  )
}

export function HackerNewsIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M0 0v24h24V0H0zm12.27 17.49h-1.09V11.7L7.5 5.34h1.24l3.04 5.46 3.04-5.46h1.24l-3.69 6.36v5.79z"/>
    </svg>
  )
}

export function DevToIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M7.42 10.05c-.18-.16-.46-.23-.84-.23H6v3.36h.58c.37 0 .65-.07.83-.22.19-.15.28-.4.28-.69v-1.53c0-.29-.09-.54-.27-.69zM24 8.4v7.2c0 4.42-3.58 8-8 8H8c-4.42 0-8-3.58-8-8V8.4c0-4.42 3.58-8 8-8h8c4.42 0 8 3.58 8 8zM10.61 12.5c0-.97-.36-1.69-1.07-2.16-.66-.43-1.55-.64-2.66-.64H3.92v8.32h2.96c1.13 0 2.04-.22 2.7-.65.71-.46 1.07-1.2 1.07-2.21v-2.66zM9.4 15.4c0 .36-.08.65-.24.86-.16.2-.41.31-.74.31H6v-2.7h2.42c.33 0 .58.11.74.32.16.21.24.5.24.87v.34zm6.46-2.45c.4-.42.61-.99.61-1.71 0-.72-.21-1.28-.62-1.7-.41-.42-.99-.62-1.74-.62-.76 0-1.34.21-1.76.62-.41.42-.62.99-.62 1.7v3.16c0 .72.21 1.28.62 1.7.42.42 1 .62 1.76.62.74 0 1.32-.2 1.73-.61.41-.41.62-.98.62-1.7v-.42h-1.95v.41c0 .28-.05.49-.16.62-.11.13-.27.2-.49.2s-.39-.07-.5-.2c-.11-.13-.16-.35-.16-.63v-1.31h2.66v-1.84zm-1.96-.55v-.97c0-.27.05-.48.16-.62.1-.14.27-.21.49-.21s.39.07.5.21c.11.14.16.35.16.62v.97h-1.31zM21 11.13h-1.94V9.5h-1.41v1.63H16v1.41h1.65v3.66c0 .71.18 1.24.54 1.6.36.36.86.54 1.5.54.32 0 .61-.03.88-.1.27-.07.51-.17.71-.31l-.39-1.31c-.31.16-.62.24-.93.24-.28 0-.49-.07-.61-.21-.13-.15-.19-.39-.19-.72V12.54H21v-1.41z"/>
    </svg>
  )
}

export function LobstersIcon({ className, title }: { className?: string; title?: string }) {
  // Stylized "L" inside a circle — instantly recognizable as Lobsters brand
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H7V8h2v6h2v2zm6-4c0 1.1-.45 2.1-1.18 2.82L13.5 17H11l2.71-2.71c.18-.18.29-.43.29-.71 0-.55-.45-1-1-1h-1.71L13.5 10.5h.5c.83 0 1.5.67 1.5 1.5 0 .55-.45 1-1 1h-.71L13.5 13.21l.21-.21h.29c.55 0 1-.45 1-1s-.45-1-1-1h-1.5L11 12.5l1.5 1.5h1c1.66 0 3-1.34 3-3s-1.34-3-3-3h-1.5L11 9.5l1.5 1.5h.5c.55 0 1 .45 1 1z"/>
    </svg>
  )
}

export function StackOverflowIcon({ className, title }: { className?: string; title?: string }) {
  // Classic Stack Overflow logo — bracket stack
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M17.36 20.2v-5.4h1.8v7.2H2.4v-7.2h1.8v5.4h13.16M4.6 14.45l.4 1.8 10.4-2.3-.4-1.8-10.4 2.3zm1.4-4.3.8 1.7 9.7-4.6-.8-1.7-9.7 4.6zm2.6-4 1.2 1.4 8.2-6.8-1.2-1.4-8.2 6.8zM14.7 1.6l-1.5 1 5.8 8.4 1.5-1-5.8-8.4zM4.8 18.4h11.3v-1.8H4.8v1.8z"/>
    </svg>
  )
}

export function NpmIcon({ className, title }: { className?: string; title?: string }) {
  // Classic npm "N" logo
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0v1.336H8V8.667h8.666v8H12V13.998H10.666zm6.665 0H14.666V8.667h2.665v5.331zM21.334 14h-1.333V8.667h1.333V14z"/>
    </svg>
  )
}

export function HuggingFaceIcon({ className, title }: { className?: string; title?: string }) {
  // Hugging Face emoji-style smiley face mark
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 22.5C6.201 22.5 1.5 17.799 1.5 12S6.201 1.5 12 1.5 22.5 6.201 22.5 12 17.799 22.5 12 22.5zM8.5 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7 14c0 1.5 2.5 3 5 3s5-1.5 5-3H7z"/>
    </svg>
  )
}
