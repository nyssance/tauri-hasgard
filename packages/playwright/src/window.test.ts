import { expect, test, vi } from 'vitest';
import { HasgardRpcClient } from './rpc-client.js';
import { HasgardWindow } from './window.js';

test('role locator refreshes the snapshot and sends the resolved ref to the requested window', async () => {
  const rpc = new HasgardRpcClient('/unused');
  const call = vi.spyOn(rpc, 'call');
  call.mockImplementation(async (method, params) => {
    if (method === 'snapshot') {
      return {
        elements: [
          { ref: 'e1', role: 'button', depth: 1, name: 'Cancel' },
          { ref: 'e2', role: 'button', depth: 1, name: 'Save' },
        ],
      };
    }
    if (method === 'click') return { ok: true };
    throw new Error(`Unexpected method: ${method}`);
  });

  const window = new HasgardWindow(rpc, 'settings');
  await window.getByRole('button', { name: 'Save', exact: true }).click();

  expect(call).toHaveBeenNthCalledWith(1, 'snapshot', { window: 'settings' });
  expect(call).toHaveBeenNthCalledWith(2, 'click', { ref: 'e2', window: 'settings' });
});

test('role locator rejects ambiguous matches instead of choosing one', async () => {
  const rpc = new HasgardRpcClient('/unused');
  vi.spyOn(rpc, 'call').mockResolvedValue({
    elements: [
      { ref: 'e1', role: 'button', depth: 1, name: 'Save draft' },
      { ref: 'e2', role: 'button', depth: 1, name: 'Save copy' },
    ],
  });

  const locator = new HasgardWindow(rpc, 'main').getByRole('button', { name: 'Save' });
  await expect(locator.click()).rejects.toThrow('resolved to 2 elements; expected exactly one');
});

test('selector count validates the bridge object shape', async () => {
  const rpc = new HasgardRpcClient('/unused');
  const call = vi.spyOn(rpc, 'call').mockResolvedValue({ count: 80 });
  const window = new HasgardWindow(rpc, 'main');

  await expect(window.locator('[data-turn]').count()).resolves.toBe(80);
  expect(call).toHaveBeenCalledWith('count', { selector: '[data-turn]', window: 'main' });
});

test('keeps snapshot and action atomic for concurrent semantic locators in one window', async () => {
  const rpc = new HasgardRpcClient('/unused');
  const methods: string[] = [];
  let snapshot = 0;
  vi.spyOn(rpc, 'call').mockImplementation(async (method) => {
    methods.push(method);
    if (method === 'snapshot') {
      snapshot += 1;
      return { elements: [{ ref: `e${snapshot}`, role: 'button', depth: 1, name: 'Run' }] };
    }
    if (method === 'click') return { ok: true };
    throw new Error(`Unexpected method: ${method}`);
  });
  const window = new HasgardWindow(rpc, 'main');

  await Promise.all([
    window.getByRole('button', { name: 'Run', exact: true }).click(),
    window.getByRole('button', { name: 'Run', exact: true }).click(),
  ]);

  expect(methods).toEqual(['snapshot', 'click', 'snapshot', 'click']);
});
