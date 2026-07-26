import { describe, expect, it } from 'vitest'
import type {
  DocumentExtractionProvider,
  ScanResult,
  StorageObjectMetadata,
  StorageProvider,
  VirusScanProvider,
} from './types'

/** Proves `StorageProvider` is implementable with zero I/O and no provider package — no `@aws-sdk/*` import here. */
class FakeStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, StorageObjectMetadata>()

  async createSignedUploadUrl(params: { key: string; contentType: string; maxBytes: number }) {
    this.objects.set(params.key, { bytes: 0, contentType: params.contentType, sha256: null })
    return { url: `https://fake.local/upload/${params.key}`, method: 'PUT' as const, headers: {}, expiresAt: new Date(0).toISOString() }
  }

  async createSignedDownloadUrl(params: { key: string; expiresInSeconds: number }) {
    return { url: `https://fake.local/download/${params.key}`, method: 'GET' as const, expiresAt: new Date(params.expiresInSeconds * 1000).toISOString() }
  }

  async headObject(params: { key: string }) {
    return this.objects.get(params.key) ?? null
  }

  async deleteObject(params: { key: string }) {
    this.objects.delete(params.key)
  }

  async moveObject(params: { fromKey: string; toKey: string }) {
    const metadata = this.objects.get(params.fromKey)
    if (metadata) {
      this.objects.set(params.toKey, metadata)
      this.objects.delete(params.fromKey)
    }
  }
}

class FakeVirusScanProvider implements VirusScanProvider {
  async scanObject(_params: { key: string }): Promise<ScanResult> {
    return { status: 'clean', detailCode: null }
  }
}

class FakeDocumentExtractionProvider implements DocumentExtractionProvider {
  async extractText(_params: { key: string; mediaType: string }) {
    return { text: 'extracted text', sectionMap: [{ page: 1, offset: 0 }], parserVersion: 'fake-v1' }
  }
}

describe('storage provider interfaces', () => {
  it('a fake StorageProvider round-trips an upload/head/move/delete cycle', async () => {
    const storage = new FakeStorageProvider()
    await storage.createSignedUploadUrl({ key: 'quarantine/abc', contentType: 'application/pdf', maxBytes: 1024 })
    expect(await storage.headObject({ key: 'quarantine/abc' })).not.toBeNull()

    await storage.moveObject({ fromKey: 'quarantine/abc', toKey: 'clean/abc' })
    expect(await storage.headObject({ key: 'quarantine/abc' })).toBeNull()
    expect(await storage.headObject({ key: 'clean/abc' })).not.toBeNull()

    await storage.deleteObject({ key: 'clean/abc' })
    expect(await storage.headObject({ key: 'clean/abc' })).toBeNull()
  })

  it('a fake VirusScanProvider returns a normalized ScanResult', async () => {
    const scanner = new FakeVirusScanProvider()
    const result = await scanner.scanObject({ key: 'clean/abc' })
    expect(result.status).toBe('clean')
  })

  it('a fake DocumentExtractionProvider returns normalized extraction text', async () => {
    const extractor = new FakeDocumentExtractionProvider()
    const result = await extractor.extractText({ key: 'clean/abc', mediaType: 'application/pdf' })
    expect(result.text).toBe('extracted text')
    expect(result.parserVersion).toBe('fake-v1')
  })
})
