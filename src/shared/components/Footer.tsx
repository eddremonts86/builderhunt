import * as React from 'react'
import { Link } from '@tanstack/react-router'

function Logo({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-md shrink-0" style={{ width: size, height: size, background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }} aria-hidden="true">
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <path d="M5 4h7a4 4 0 0 1 4 4v1" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M16 4h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-7a4 4 0 0 0-4 4v3" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M8 20H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h7a4 4 0 0 0 4-4V7" stroke="white" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="11" cy="12" r="1.9" fill="#06b6d4" />
      </svg>
    </span>
  )
}

export function Footer() {
  return (
    <footer className="border-t border-bh-border bg-bh-bg-alt/30" data-testid="site-footer">
      <div className="container py-16">
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-12 mb-12">
          <div className="lg:col-span-2">
            <Link to="/" className="flex items-center gap-2.5 mb-4 group">
              <Logo size={28} />
              <span className="font-bold text-lg tracking-tight group-hover:text-bh-accent transition-colors">BuilderHunt</span>
            </Link>
            <p className="text-sm text-bh-text-muted max-w-sm leading-relaxed">
              Find active open-source builders across the open web. Track GitHub stars, Hacker News comments, and Reddit velocity from one clean dashboard.
            </p>
          </div>
          <div>
            <h3 className="font-bold text-bh-text mb-4 text-xs uppercase tracking-wider">Product</h3>
            <ul className="space-y-2.5 text-sm text-bh-text-muted">
              <li><Link to="/explore" className="hover:text-bh-accent transition-colors" data-testid="footer-explore">Explore Profiles</Link></li>
              <li><Link to="/blog" className="hover:text-bh-accent transition-colors" data-testid="footer-blog">Blog & Case Studies</Link></li>
              <li><Link to="/pricing" className="hover:text-bh-accent transition-colors" data-testid="footer-pricing">Pricing Plans</Link></li>
              <li><a href="/#how-it-works" className="hover:text-bh-accent transition-colors">How it works</a></li>
            </ul>
          </div>
          <div>
            <h3 className="font-bold text-bh-text mb-4 text-xs uppercase tracking-wider">Trust & Legal</h3>
            <ul className="space-y-2.5 text-sm text-bh-text-muted">
              <li>
                <Link to="/status" className="hover:text-bh-accent transition-colors inline-flex items-center gap-1.5" data-testid="footer-status">
                  <span className="w-1.5 h-1.5 rounded-full bg-bh-success inline-block" aria-hidden="true" />
                  Status
                </Link>
              </li>
              <li><Link to="/changelog" className="hover:text-bh-accent transition-colors" data-testid="footer-changelog">Changelog</Link></li>
              <li><Link to="/legal/terms" className="hover:text-bh-accent transition-colors" data-testid="footer-terms">Terms of Service</Link></li>
              <li><Link to="/legal/privacy" className="hover:text-bh-accent transition-colors" data-testid="footer-privacy">Privacy Policy</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="font-bold text-bh-text mb-4 text-xs uppercase tracking-wider">Contact</h3>
            <ul className="space-y-2.5 text-sm text-bh-text-muted">
              <li><a href="mailto:privacy@builderhunt.dev" className="hover:text-bh-accent transition-colors" data-testid="footer-do-not-sell">Do Not Sell My Info</a></li>
              <li><a href="mailto:support@builderhunt.dev" className="hover:text-bh-accent transition-colors">Get Support</a></li>
              <li><span className="text-xs bg-bh-accent-soft border border-bh-accent/20 text-bh-accent px-2 py-0.5 rounded-full font-bold">Beta version</span></li>
            </ul>
          </div>
        </div>
        <div className="pt-8 border-t border-bh-border/65 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-bh-text-dim">
          <p>© {new Date().getFullYear()} BuilderHunt. Built for builders, by builders.</p>
          <p>Made with ☕ in Barcelona, Madrid &amp; remote.</p>
        </div>
      </div>
    </footer>
  )
}

