import { describe, expect, it, vi } from 'vitest';

import {
  credentialRefForResource,
  OpdsClient,
  type OpdsClientInvoker,
  type OpdsSource,
} from '../opds-client.js';

describe('OpdsClient', () => {
  it('maps source, browse, and search calls to native commands', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ command, args });
        return (command === 'opds_list_sources' ? [] : {}) as T;
    };
    const invoker: OpdsClientInvoker = {
      invoke: vi.fn(invoke) as unknown as OpdsClientInvoker['invoke'],
    };
    const client = new OpdsClient(invoker);

    await client.addSource({ title: '本地书库', url: 'https://books.example/opds' });
    await client.browse('source-1', 'https://books.example/opds?page=2');
    await client.search('source-1', '三体');
    await client.removeSource('source-1');

    expect(calls).toEqual([
      {
        command: 'opds_add_source',
        args: { source: { title: '本地书库', url: 'https://books.example/opds' } },
      },
      {
        command: 'opds_browse',
        args: { sourceId: 'source-1', url: 'https://books.example/opds?page=2' },
      },
      { command: 'opds_search', args: { sourceId: 'source-1', query: '三体' } },
      { command: 'opds_remove_source', args: { sourceId: 'source-1' } },
    ]);
  });

  it('does not transform or persist credential fields in the client', async () => {
    const invoke = vi.fn(async <T>(_command: string, _args?: Record<string, unknown>): Promise<T> => ({
      id: 'source-1',
    }) as T);
    const client = new OpdsClient({
      invoke: invoke as unknown as OpdsClientInvoker['invoke'],
    });
    const credential = { kind: 'bearer' as const, token: 'session-token' };

    await client.addSource({
      title: '受保护书库',
      url: 'https://books.example/opds',
      credential,
    });

    expect(invoke).toHaveBeenCalledWith('opds_add_source', {
      source: expect.objectContaining({ credential }),
    });
  });

  it('scopes source credentials to the same URL origin', () => {
    const source: OpdsSource = {
      id: 'source-1',
      title: '受保护书库',
      url: 'https://books.example/opds',
      credentialRef: 'credential-1',
      allowHttp: false,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(credentialRefForResource(source, 'https://books.example:443/book.cbz')).toBe(
      'credential-1',
    );
    expect(credentialRefForResource(source, 'https://cdn.example/book.cbz')).toBeUndefined();
    expect(credentialRefForResource(source, 'http://books.example/book.cbz')).toBeUndefined();
  });
});
