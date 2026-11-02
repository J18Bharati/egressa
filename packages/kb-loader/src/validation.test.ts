import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  KnowledgeBaseError,
  SOURCE_PUBLISHERS,
  TRANSFER_MECHANISMS,
  loadKnowledgeBase,
} from './index.js';

/** A throwaway copy of the shipped kb/, so a test can break one file of it. */
function scratchKb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'egressa-kb-validate-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cpSync('kb', dir, { recursive: true });
  return dir;
}

// A test that deliberately writes wrong data cannot also be typed as right data.
// biome-ignore lint/suspicious/noExplicitAny: the entries here are meant to be invalid
type Loose = Record<string, any>;

function editVendor(dir: string, id: string, edit: (entry: Loose) => void): string {
  const file = join(dir, 'vendors', `${id}.json`);
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  edit(entry);
  writeFileSync(file, JSON.stringify(entry, null, 2));
  return file;
}

function loadError(dir: string): KnowledgeBaseError {
  try {
    loadKnowledgeBase({ kbPath: dir });
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeBaseError);
    return error as KnowledgeBaseError;
  }
  throw new Error('expected loadKnowledgeBase to throw');
}

describe('the knowledge base is validated when it is loaded, not cast', () => {
  it('loads the shipped knowledge base unchanged', () => {
    const kb = loadKnowledgeBase({ kbPath: 'kb' });
    expect(kb.vendors.length).toBeGreaterThan(0);
    expect(kb.byId.get('stripe')?.name).toBeTruthy();
  });

  it('refuses a wrong-typed field, naming the file and the JSON path', () => {
    const dir = scratchKb();
    const file = editVendor(dir, 'stripe', (e) => {
      e.processing.euRegion.available = 'yes';
    });
    const error = loadError(dir);
    expect(error.file).toBe(file);
    expect(error.message).toContain(file);
    expect(error.message).toContain('/processing/euRegion/available');
  });

  it('refuses a transfer mechanism the schema does not list, and says what it allows', () => {
    const dir = scratchKb();
    const file = editVendor(dir, 'stripe', (e) => {
      e.legal.transferMechanisms[0].mechanism = 'handshake';
    });
    const error = loadError(dir);
    expect(error.message).toContain(file);
    expect(error.message).toContain('/legal/transferMechanisms/0/mechanism');
    expect(error.message).toContain('SCC');
  });

  it('refuses a missing required field', () => {
    const dir = scratchKb();
    const file = editVendor(dir, 'stripe', (e) => {
      e.legal = undefined;
    });
    const error = loadError(dir);
    expect(error.message).toContain(file);
    expect(error.message).toContain('legal');
  });

  it('refuses malformed JSON, naming the file', () => {
    const dir = scratchKb();
    const file = join(dir, 'vendors', 'stripe.json');
    writeFileSync(file, '{ "id": "stripe", ');
    const error = loadError(dir);
    expect(error.file).toBe(file);
    expect(error.message).toContain(file);
  });

  it('validates the adequacy file too', () => {
    const dir = scratchKb();
    const file = join(dir, 'adequacy-status.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.decisions[0].status = 'maybe';
    writeFileSync(file, JSON.stringify(doc));
    const error = loadError(dir);
    expect(error.message).toContain(file);
    expect(error.message).toContain('/decisions/0/status');
  });

  it('reports a file it cannot read as a knowledge base error, not a raw ENOENT', () => {
    const dir = scratchKb();
    rmSync(join(dir, 'kb.version'));
    const error = loadError(dir);
    expect(error.message).toContain('kb.version');
  });

  it('does not take its schema from the knowledge base being loaded', () => {
    // A kb/ that ships a permissive schema of its own must not be able to vouch
    // for itself: the schema is the tool's, the data is the user's.
    const dir = scratchKb();
    writeFileSync(join(dir, 'schema', 'vendor-1.0.0.json'), '{}');
    editVendor(dir, 'stripe', (e) => {
      e.legal.transferMechanisms[0].mechanism = 'handshake';
    });
    expect(() => loadKnowledgeBase({ kbPath: dir })).toThrow(KnowledgeBaseError);
  });
});

describe('the union types agree with the published schema', () => {
  const schema = (name: string) => JSON.parse(readFileSync(join('kb', 'schema', name), 'utf8'));

  it('lists the same transfer mechanisms as vendor-1.0.0.json', () => {
    const vendor = schema('vendor-1.0.0.json');
    const fromSchema = vendor.properties.legal.properties.transferMechanisms.items.properties
      .mechanism.enum as string[];
    expect([...TRANSFER_MECHANISMS].sort()).toEqual([...fromSchema].sort());
  });

  it('lists the same source publishers as vendor-1.0.0.json and adequacy-status-1.0.0.json', () => {
    const vendor = schema('vendor-1.0.0.json');
    const adequacy = schema('adequacy-status-1.0.0.json');
    const fromVendor = vendor.properties.sources.items.properties.publisher.enum as string[];
    const fromAdequacy = adequacy.properties.sources.items.properties.publisher.enum as string[];
    expect([...SOURCE_PUBLISHERS].sort()).toEqual([...fromVendor].sort());
    expect([...SOURCE_PUBLISHERS].sort()).toEqual([...fromAdequacy].sort());
  });
});

describe('a bad --kb is a knowledge base failure at the command line', () => {
  it('exits 4 and names the file', () => {
    const dir = scratchKb();
    const file = editVendor(dir, 'stripe', (e) => {
      e.legal.transferMechanisms[0].mechanism = 'handshake';
    });
    let code = 0;
    let stderr = '';
    try {
      execFileSync(
        'npx',
        ['tsx', 'packages/cli/src/cli.ts', 'scan', 'fixtures/repos/clean-eu-only', '--kb', dir],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      const e = error as { status: number; stderr: string };
      code = e.status;
      stderr = e.stderr;
    }
    expect(code).toBe(4);
    expect(stderr).toContain(file);
  }, 60_000);
});
