import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWorkspaceForView } from '../public/js/features/workspace-session.js';

// A bind that fails must never be able to destroy a session that already holds
// work. The window is real: the id used to be published before the PUT, so the
// user could hit Send and persist a turn into a session the failed bind then
// deleted. These tests pin the ordering and the scope of the delete.

function recorder() {
  const calls = [];
  return {
    calls,
    create: async () => {
      calls.push('create');
      return 'fresh-id';
    },
    discard: async (id) => {
      calls.push(`discard:${id}`);
    },
    bind: (id, directory) => {
      calls.push(`bind:${id}:${directory}`);
      return Promise.resolve({ workspace: { root: directory }, overview: { files: 3 } });
    },
  };
}

test('an existing session is never created and never deleted', async () => {
  const rec = recorder();
  const outcome = await bindWorkspaceForView({
    currentId: 'existing-id',
    directory: '/tmp/project',
    create: rec.create,
    discard: rec.discard,
    bind: rec.bind,
  });

  assert.deepEqual(rec.calls, ['bind:existing-id:/tmp/project']);
  assert.equal(outcome.id, 'existing-id');
  assert.equal(outcome.created, false);
});

test('a newly created session is deleted when its bind fails', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      bindWorkspaceForView({
        currentId: null,
        directory: '/tmp/gone',
        create: async () => {
          calls.push('create');
          return 'fresh-id';
        },
        discard: async (id) => {
          calls.push(`discard:${id}`);
        },
        bind: async () => {
          calls.push('bind');
          throw new Error('工作目录不存在或无权访问');
        },
      }),
    /不存在/,
  );
  assert.deepEqual(calls, ['create', 'bind', 'discard:fresh-id']);
});

test('a failed cleanup does not replace the bind error', async () => {
  await assert.rejects(
    () =>
      bindWorkspaceForView({
        currentId: null,
        directory: '/tmp/gone',
        create: async () => 'fresh-id',
        discard: async () => {
          throw new Error('网络错误');
        },
        bind: async () => {
          throw new Error('工作目录不存在或无权访问');
        },
      }),
    /不存在/,
    'the user must see why the bind failed, not why the cleanup failed',
  );
});

test('the created id is not returned before the bind lands', async () => {
  // Ordering proof: the successful outcome carries the same id the create
  // produced, and create ran exactly once before bind.
  const order = [];
  const outcome = await bindWorkspaceForView({
    currentId: null,
    directory: '/tmp/project',
    create: async () => {
      order.push('create');
      return 'fresh-id';
    },
    discard: async () => {
      order.push('discard');
    },
    bind: async (id) => {
      order.push('bind');
      assert.equal(id, 'fresh-id');
      return { workspace: { root: '/tmp/project' }, overview: { files: 1 } };
    },
  });
  assert.deepEqual(order, ['create', 'bind']);
  assert.equal(outcome.id, 'fresh-id');
  assert.equal(outcome.created, true);
  assert.equal(outcome.bound.overview.files, 1);
});

test('a slow failed bind never touches a session that was created elsewhere', async () => {
  // The race the ordering exists for: while the bind is in flight another view
  // publishes a different session. Only the id from this call may be deleted.
  const removed = [];
  let releaseBind;
  const bindGate = new Promise((resolve) => {
    releaseBind = resolve;
  });
  const pending = bindWorkspaceForView({
    currentId: null,
    directory: '/tmp/gone',
    create: async () => 'fresh-id',
    discard: async (id) => {
      removed.push(id);
    },
    bind: () =>
      bindGate.then(() => {
        throw new Error('工作目录不存在或无权访问');
      }),
  });

  releaseBind();
  await assert.rejects(() => pending, /不存在/);
  assert.deepEqual(removed, ['fresh-id'], 'only this call\'s id is ever removed');
});

test('a view adopted by a turn while the picker was open binds nothing', async () => {
  // A chat turn's `session` event sets state.sessionId without changing
  // viewSeq. Binding the private row afterwards would paint its folder onto the
  // turn's session and leave a directory-only row behind.
  const calls = [];
  const outcome = await bindWorkspaceForView({
    currentId: null,
    directory: '/tmp/project',
    create: async () => {
      calls.push('create');
      return 'fresh-id';
    },
    discard: async (id) => {
      calls.push(`discard:${id}`);
    },
    bind: async () => {
      calls.push('bind');
      return { workspace: { root: '/tmp/project' }, overview: { files: 1 } };
    },
    isStillCurrent: () => false,
  });

  assert.deepEqual(calls, ['create', 'discard:fresh-id'], 'the private row is discarded, never bound');
  assert.equal(outcome.applied, false);
  assert.equal(outcome.bound, null);
});

test('a bind that succeeded is never discarded, even when the view moved on', async () => {
  // The server persists the binding before responding, and a bound row is
  // immediately listable, so another tab can be using it. Deleting it would
  // drop a live directory.
  const calls = [];
  let adopted = false;
  const pending = bindWorkspaceForView({
    currentId: null,
    directory: '/tmp/project',
    create: async () => {
      calls.push('create');
      return 'fresh-id';
    },
    discard: async (id) => {
      calls.push(`discard:${id}`);
    },
    bind: async (id) => {
      calls.push(`bind:${id}`);
      adopted = true; // the turn's `session` event lands mid-request
      return { workspace: { root: '/tmp/project' }, overview: { files: 1 } };
    },
    isStillCurrent: () => !adopted,
  });

  const outcome = await pending;
  assert.deepEqual(calls, ['create', 'bind:fresh-id'], 'a success must not delete the row');
  assert.equal(outcome.applied, false, 'the binding must not be applied to the adopted view');
  assert.equal(outcome.bound.overview.files, 1);
});

test('a failure deletes through the guarded endpoint, never the plain delete', async () => {
  // The request can have reached the server and persisted the binding before
  // the failure surfaced, so the cleanup must be the conditional one.
  const calls = [];
  await assert.rejects(
    () =>
      bindWorkspaceForView({
        currentId: null,
        directory: '/tmp/project',
        create: async () => 'fresh-id',
        discard: async (id) => {
          calls.push(`discard:${id}`);
        },
        bind: async () => {
          throw new Error('网络中断');
        },
      }),
    /网络中断/,
  );
  assert.deepEqual(calls, ['discard:fresh-id']);
});

test('a same-view session change is detected as a different target', async () => {
  const { workspaceTarget, isSameWorkspaceTarget } = await import('../public/js/features/workspace-session.js');
  const before = workspaceTarget({ viewSeq: 7, sessionId: null });
  // The SSE `session` event: same view, new session.
  const after = workspaceTarget({ viewSeq: 7, sessionId: 'abc123' });
  assert.equal(before.viewSeq, after.viewSeq);
  assert.equal(isSameWorkspaceTarget(before, after), false, 'a session change invalidates the target');

  // A real view switch invalidates it too.
  assert.equal(isSameWorkspaceTarget(before, workspaceTarget({ viewSeq: 8, sessionId: null })), false);
  // An unchanged target survives.
  assert.equal(isSameWorkspaceTarget(before, workspaceTarget({ viewSeq: 7, sessionId: null })), true);
});
