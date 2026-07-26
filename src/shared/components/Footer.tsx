import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'

export function Footer() {
  return (
    <footer className="mt-[25px] border-t border-bh-border/50 bg-bh-bg-alt/30 pt-16 pb-12" data-testid="site-footer">
      <div className="container">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-10 mb-12">
          {/* Logo & Info */}
          <div className="col-span-2">
            <Link to="/" className="flex items-center gap-2.5 mb-4 group">
              <BrandLogoMark size={26} />
              <span className="font-bold text-base tracking-tight text-bh-text group-hover:text-bh-accent transition-colors">BuilderHunt</span>
            </Link>
            <p className="text-sm text-bh-text-muted max-w-sm leading-relaxed mb-4">
              Find active open-source builders across the open web. Track GitHub stars, Hacker News comments, and Reddit velocity from one clean dashboard.
            </p>
            <span className="inline-flex items-center gap-1.5 text-xs bg-bh-accent-soft border border-bh-accent/25 text-bh-accent px-2.5 py-1 rounded-full font-bold">
              Beta version · Free during beta
            </span>
          </div>

          {/* Product */}
          <div>
            <h3 className="font-bold text-bh-text-dim mb-4 text-xs uppercase tracking-wider">Product</h3>
            <ul className="space-y-3 text-sm text-bh-text-muted">
              <li><Link to="/explore" className="hover:text-bh-accent transition-colors" data-testid="footer-explore">Explore</Link></li>
              <li><Link to="/blog" className="hover:text-bh-accent transition-colors" data-testid="footer-blog">Blog</Link></li>
              <li><Link to="/pricing" className="hover:text-bh-accent transition-colors" data-testid="footer-pricing">Pricing</Link></li>
              <li><a href="/#how-it-works" className="hover:text-bh-accent transition-colors">How it works</a></li>
            </ul>
          </div>

          {/* Trust */}
          <div>
            <h3 className="font-bold text-bh-text-dim mb-4 text-xs uppercase tracking-wider">Trust</h3>
            <ul className="space-y-3 text-sm text-bh-text-muted">
              <li>
                <Link to="/status" className="hover:text-bh-accent transition-colors inline-flex items-center gap-1.5" data-testid="footer-status">
                  <span className="w-1.5 h-1.5 rounded-full bg-bh-success inline-block" aria-hidden="true" />
                  Status
                </Link>
              </li>
              <li><Link to="/changelog" className="hover:text-bh-accent transition-colors" data-testid="footer-changelog">Changelog</Link></li>
              <li><Link to="/roadmap" className="hover:text-bh-accent transition-colors" data-testid="footer-roadmap">Roadmap</Link></li>
              <li><Link to="/security" className="hover:text-bh-accent transition-colors" data-testid="footer-security">Security</Link></li>
            </ul>
          </div>

          {/* Account */}
          <div>
            <h3 className="font-bold text-bh-text-dim mb-4 text-xs uppercase tracking-wider">Account</h3>
            <ul className="space-y-3 text-sm text-bh-text-muted">
              <li><Link to="/auth/sign-in" className="hover:text-bh-accent transition-colors">Sign in</Link></li>
              <li><Link to="/auth/sign-up" className="hover:text-bh-accent transition-colors">Create account</Link></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-bold text-bh-text-dim mb-4 text-xs uppercase tracking-wider">Legal</h3>
            <ul className="space-y-3 text-sm text-bh-text-muted">
              <li><Link to="/legal/terms" className="hover:text-bh-accent transition-colors" data-testid="footer-terms">Terms of Service</Link></li>
              <li><Link to="/legal/privacy" className="hover:text-bh-accent transition-colors" data-testid="footer-privacy">Privacy Policy</Link></li>
              <li><Link to="/legal/cookies" className="hover:text-bh-accent transition-colors" data-testid="footer-cookies">Cookie Policy</Link></li>
              <li><Link to="/legal/imprint" className="hover:text-bh-accent transition-colors" data-testid="footer-imprint">Imprint</Link></li>
              <li><Link to="/privacy/remove" className="hover:text-bh-accent transition-colors" data-testid="footer-remove-profile">Remove my profile</Link></li>
              <li><a href="mailto:privacy@builderhunt.dev" className="hover:text-bh-accent transition-colors" data-testid="footer-do-not-sell">Do Not Sell My Info</a></li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-bh-border/50 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-bh-text-dim">
          <p>© {new Date().getFullYear()} BuilderHunt. Built for builders, by builders.</p>
          <p>Made with ☕ in Barcelona, Madrid &amp; remote.</p>
        </div>
      </div>
    </footer>
  )
}
