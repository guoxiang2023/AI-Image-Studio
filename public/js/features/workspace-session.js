/**
 * Identifies what the user is looking at.
 *
 * `viewSeq` alone is not enough: a chat turn's `session` event sets
 * `state.sessionId` without touching `viewSeq`, so a bind that started in a
 * brand-new chat can finish after the first turn has already bound the view to
 * its own session. Applying the private row's binding then would paint one
 * chat's folder onto another chat's chip.
 */
export function workspaceTarget(state) {
  return { viewSeq: state.viewSeq, sessionId: state.sessionId || null };
}

export function isSameWorkspaceTarget(before, after) {
  return before.viewSeq === after.viewSeq && before.sessionId === after.sessionId;
}

/**
 * Binds a directory to the session a view is showing.
 *
 * The whole point of this module is ordering, which is why it is separated from
 * the DOM code and takes its calls as arguments:
 *
 *   - A session created for a bind is NOT published (state + URL) until the bind
 *     has landed. Publishing first let a Send persist a real turn into a session
 *     that a failed bind was about to delete — an unconditional DELETE then
 *     destroyed work the user had watched arrive.
 *   - A delete only ever targets an id returned by `create` in this same call,
 *     so a caller's existing session can never be removed by a failed bind.
 *   - An id that was never published is only known to this caller, so removing
 *     it on failure cannot race another view or another tab.
 *
 * Returns `{ id, created, bound }`; the caller decides whether it is still
 * looking at the view that asked before it repaints anything.
 */
export async function bindWorkspaceForView({
  currentId,
  directory,
  create,
  discard,
  bind,
  isStillCurrent = () => true,
}) {
  if (currentId) {
    // Replacing a directory on an existing session: a failure leaves the old
    // text and the row untouched, so there is nothing to undo.
    const bound = await bind(currentId, directory);
    return { id: currentId, created: false, bound, applied: isStillCurrent() };
  }

  const id = await create();
  // A turn's `session` event can adopt this view while the picker or the request
  // is open. Binding then would attach the folder to a session the screen has
  // left, so the row is dropped instead — through `discard`, which the server
  // applies atomically only while the row is still empty, unbound and
  // unarchived. Nothing else needs to be true for this to be safe.
  if (!isStillCurrent()) {
    await discard(id).catch(() => {});
    return { id, created: true, bound: null, applied: false };
  }

  let bound;
  try {
    bound = await bind(id, directory);
  } catch (error) {
    // The bind failed, but the row is NOT assumed disposable: the request may
    // have reached the server and persisted a binding before the failure. The
    // guarded discard is a no-op in that case, so a live binding is never lost.
    await discard(id).catch(() => {});
    throw error;
  }
  // A bind that succeeded is never deleted, even if the view moved on: the row
  // now holds a real directory and another tab may already be using it. The
  // caller applies the binding only when the view still matches.
  return { id, created: true, bound, applied: isStillCurrent() };
}
