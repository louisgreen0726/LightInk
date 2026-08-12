import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface SecurityConfig {
  readonly csp: string;
  readonly devCsp: string;
}

interface TauriConfig {
  readonly app: { readonly security: SecurityConfig };
}

const config = JSON.parse(
  readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf-8'),
) as TauriConfig;

function directive(policy: string, name: string): readonly string[] {
  const value = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([candidate]) => candidate === name);
  return value?.slice(1) ?? [];
}

describe('Tauri content security policy', () => {
  it('restricts executable and document-boundary capabilities in every mode', () => {
    for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
      expect(directive(policy, 'script-src')).toEqual(["'self'"]);
      expect(directive(policy, 'object-src')).toEqual(["'none'"]);
      expect(directive(policy, 'base-uri')).toEqual(["'none'"]);
      expect(directive(policy, 'form-action')).toEqual(["'none'"]);
      expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
      expect(policy).not.toContain("'unsafe-eval'");
    }
  });

  it('limits IPC while retaining resources required by explicit application flows', () => {
    expect(directive(config.app.security.csp, 'connect-src')).toEqual([
      'ipc:',
      'http://ipc.localhost',
    ]);
    expect(directive(config.app.security.csp, 'worker-src')).toEqual(["'self'", 'blob:']);
    expect(directive(config.app.security.csp, 'font-src')).toEqual(["'self'", 'data:']);
    expect(directive(config.app.security.csp, 'img-src')).toEqual(
      expect.arrayContaining(['asset:', 'data:', 'blob:', 'http:', 'https:']),
    );
  });
});
