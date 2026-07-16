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
    <footer className="border-t border-bh-border bg-bh-bg-alt/40" data-testid="site-footer">
      <div className="container py-12">
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-8 mb-8">
          <div className="lg:col-span-1">
            <Link to="/" className="flex items-center gap-2.5 mb-3">
              <Logo size={24} />
              <span className="font-bold">BuilderHunt</span>
            </Link>
            <p className="text-sm text-bh-text-muted max-w-xs">
              Find active open-source builders across the open web. Free during public beta.
            </p>
          </div>
          <div>
            <h3 className="font-semibold mb-3 text-sm">Product</h3>
            <ul className="space-y-2 text-sm text-bh-text-muted">
              <li><Link to="/explore" className="hover:text-bh-text transition-colors" data-testid="footer-explore">Explore</Link></li>
              <li><a href="/#how-it-works" className="hover:text-bh-text transition-colors">How it works</a></li>
              <li><a href="/#use-cases" className="hover:text-bh-text transition-colors">Use cases</a></li>
              <li><a href="/#sources" className="hover:text-bh-text transition-colors">Sources</a></li>
              <li><a href="/#faq" className="hover:text-bh-text transition-colors">FAQ</a></li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold mb-3 text-sm">Trust</h3>
            <ul className="space-y-2 text-sm text-bh-text-muted">
              <li>
                <Link to="/status" className="hover:text-bh-text transition-colors inline-flex items-center gap-1.5" data-testid="footer-status">
                  <span className="w-1.5 h-1.5 rounded-full bg-bh-success inline-block" aria-hidden="true" />
                  Status
                </Link>
              </li>
              <li><Link to="/changelog" className="hover:text-bh-text transition-colors" data-testid="footer-changelog">Changelog</Link></li>
              <li><Link to="/roadmap" className="hover:text-bh-text transition-colors" data-testid="footer-roadmap">Roadmap</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold mb-3 text-sm">Account</h3>
            <ul className="space-y-2 text-sm text-bh-text-muted">
              <li><Link to="/auth/sign-in" className="hover:text-bh-text transition-colors">Sign in</Link></li>
              <li><Link to="/auth/sign-up" className="hover:text-bh-text transition-colors">Create account</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold mb-3 text-sm">Legal</h3>
            <ul className="space-y-2 text-sm text-bh-text-muted">
              <li><Link to="/legal/terms" className="hover:text-bh-text transition-colors" data-testid="footer-terms">Terms of Service</Link></li>
              <li><Link to="/legal/privacy" className="hover:text-bh-text transition-colors" data-testid="footer-privacy">Privacy Policy</Link></li>
              <li><Link to="/legal/cookies" className="hover:text-bh-text transition-colors" data-testid="footer-cookies">Cookie Policy</Link></li>
              <li><Link to="/legal/imprint" className="hover:text-bh-text transition-colors" data-testid="footer-imprint">Imprint</Link></li>
              <li><a href="mailto:privacy@builderhunt.dev" className="hover:text-bh-text transition-colors" data-testid="footer-do-not-sell">Do Not Sell My Info</a></li>
            </ul>
          </div>
        </div>
        <div className="pt-8 border-t border-bh-border flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-bh-text-dim">
          <p>© {new Date().getFullYear()} BuilderHunt. Built for builders, by builders.</p>
          <p>Made with ☕ in Barcelona, Madrid &amp; remote.</p>
        </div>
      </div>
    </footer>
  )
}
